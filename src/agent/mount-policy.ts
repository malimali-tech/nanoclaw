// src/agent/mount-policy.ts
//
// Single source of truth for "what filesystem surface does this chat see".
// Both PathGuard (host-fs Read/Write/Edit/Grep/Find/Ls) and ContainerPool
// (docker bind mounts for bash) derive from the same MountPolicy so the
// two surfaces can never disagree.
//
// Why a single policy:
//   • Pi tells the LLM each skill's absolute host path. For the LLM to
//     actually use it, the host-fs tools and the bash container must agree
//     that path is reachable AND consistent on read/write semantics.
//   • Adding a new mount used to require touching path-guard.ts and
//     container-mounts.ts in lockstep; one of them inevitably drifts.
//   • PR3 uses MountPolicy.hash() to detect when a chat's mount set has
//     changed across NanoClaw restarts so a stale container gets rebuilt.
//
// Scope split per entry:
//   hostVisible=true  → the agent can touch this path via host-fs tools.
//                       Always also bind-mounted into the container.
//   hostVisible=false → container-only (e.g. /dev/null shadows, lark-cli
//                       state dir). PathGuard ignores these.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { GROUPS_DIR } from '../config.js';
import { resolveGroupFolderPath } from '../group-folder.js';
import { chatSkillsDirs } from './global-skills.js';

export type MountMode = 'rw' | 'ro';

export interface MountEntry {
  /** Absolute host path. `/dev/null` for shadow entries. */
  host: string;
  /** Path inside the container. Equals `host` for skills (host-fs path
   *  preserved so pi's <available_skills> path resolves identically on
   *  both sides). */
  container: string;
  mode: MountMode;
  /** True iff PathGuard should expose this entry to host-fs tools. */
  hostVisible: boolean;
}

export interface HostRoot {
  /** realpath-resolved host root. */
  root: string;
  writable: boolean;
}

export interface VolumeMount {
  hostPath: string;
  containerPath: string;
  readonly: boolean;
}

export interface MountPolicy {
  readonly entries: ReadonlyArray<MountEntry>;
  /** Roots PathGuard exposes to host-fs tools. Realpath-resolved. */
  hostRoots(): ReadonlyArray<HostRoot>;
  /** Bind-mount set passed to `docker run -v ...`. */
  volumeMounts(): ReadonlyArray<VolumeMount>;
  /** Stable 12-char hash of the entry set, used as a docker label so
   *  ContainerPool can detect mount drift across restarts. */
  hash(): string;
}

/** Standard container path conventions. Stable so the agent's mental
 *  model of "where am I" doesn't drift between code edits. */
export const CONTAINER_PATHS = {
  group: '/workspace/group',
  global: '/workspace/global',
  project: '/workspace/project',
  /** lark-cli config + secret store — see Dockerfile's
   *  LARKSUITE_CLI_CONFIG_DIR / LARKSUITE_CLI_DATA_DIR. */
  larkCliState: '/workspace/lark-cli',
} as const;

/**
 * Host-side directory that backs `CONTAINER_PATHS.larkCliState`. Single
 * global directory (not per-chat) so all chats share one Feishu identity,
 * matching the single-account FEISHU_APP_ID/SECRET model.
 */
export function larkCliStateDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg ? xdg : path.join(process.env.HOME ?? '', '.config');
  return path.join(base, 'nanoclaw', 'lark-cli');
}

export function ensureLarkCliStateDir(): string {
  const dir = larkCliStateDir();
  fs.mkdirSync(path.join(dir, 'config'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  return dir;
}

/**
 * Build the mount policy for one chat. The result is the canonical
 * description of "what this chat can see"; PathGuard and ContainerPool
 * both derive their views from it.
 */
export function computeMountPolicy(
  groupFolder: string,
  isMain: boolean,
): MountPolicy {
  const entries: MountEntry[] = [];
  const groupDir = resolveGroupFolderPath(groupFolder);

  // Per-chat working directory — RW for the owning chat.
  entries.push({
    host: groupDir,
    container: CONTAINER_PATHS.group,
    mode: 'rw',
    hostVisible: true,
  });

  // Shared global memory. Non-main: read-only. Main: writable.
  const globalDir = path.join(GROUPS_DIR, 'global');
  if (fs.existsSync(globalDir)) {
    entries.push({
      host: globalDir,
      container: CONTAINER_PATHS.global,
      mode: isMain ? 'rw' : 'ro',
      hostVisible: true,
    });
  }

  if (isMain) {
    // Main can read NanoClaw's own source for self-modification — RO so
    // the agent can't ship a code change that takes effect on next restart.
    const projectRoot = process.cwd();
    entries.push({
      host: projectRoot,
      container: CONTAINER_PATHS.project,
      mode: 'ro',
      hostVisible: true,
    });

    // Shadow .env so the readable project root doesn't leak credentials.
    // Container-only — host-fs already has its own real .env access path.
    const envFile = path.join(projectRoot, '.env');
    if (fs.existsSync(envFile)) {
      entries.push({
        host: '/dev/null',
        container: `${CONTAINER_PATHS.project}/.env`,
        mode: 'ro',
        hostVisible: false,
      });
    }
  }

  // Skills — bind-mounted at the host path on both sides so pi's
  // <available_skills> absolute paths resolve identically. RO: a deliberate
  // skill update goes through git, not through a stray Bash tool call.
  for (const dir of chatSkillsDirs(groupFolder, isMain)) {
    entries.push({
      host: dir,
      container: dir,
      mode: 'ro',
      hostVisible: true,
    });
  }

  // lark-cli config + secret store. Container-only RW; host-fs has no
  // legitimate reason to write here (config init runs inside the
  // container).
  const larkState = ensureLarkCliStateDir();
  entries.push({
    host: larkState,
    container: CONTAINER_PATHS.larkCliState,
    mode: 'rw',
    hostVisible: false,
  });

  return makePolicy(entries);
}

function makePolicy(entries: MountEntry[]): MountPolicy {
  const frozen: ReadonlyArray<MountEntry> = entries;
  return {
    entries: frozen,
    hostRoots() {
      return frozen
        .filter((e) => e.hostVisible)
        .map((e) => ({
          root: realIfExists(e.host),
          writable: e.mode === 'rw',
        }));
    },
    volumeMounts() {
      return frozen.map((e) => ({
        hostPath: e.host,
        containerPath: e.container,
        readonly: e.mode === 'ro',
      }));
    },
    hash() {
      // Stable JSON: entries are emitted in policy order (already
      // deterministic per groupFolder/isMain). Include every field that
      // affects either surface so a single byte change recreates the
      // container.
      const canonical = JSON.stringify(
        frozen.map((e) => [e.host, e.container, e.mode, e.hostVisible]),
      );
      return crypto
        .createHash('sha256')
        .update(canonical)
        .digest('hex')
        .slice(0, 12);
    },
  };
}

/**
 * fs.realpathSync if the path exists, else the lexically-normalized
 * absolute form. Lets us validate writes to not-yet-created files (Write
 * tool's main use case) while still defeating ../ tricks.
 *
 * For the not-yet-existing case we resolve the parent directory's
 * realpath then rejoin the basename — so a symlinked `groups/alice` →
 * `/elsewhere/alice` followed by writing `groups/alice/new.md` resolves
 * correctly even when `new.md` doesn't exist yet.
 */
export function realIfExists(p: string): string {
  const abs = path.resolve(p);
  if (fs.existsSync(abs)) {
    try {
      return fs.realpathSync(abs);
    } catch {
      return abs;
    }
  }
  let cur = abs;
  const tail: string[] = [];
  while (!fs.existsSync(cur)) {
    const parent = path.dirname(cur);
    if (parent === cur) return abs;
    tail.unshift(path.basename(cur));
    cur = parent;
  }
  try {
    return path.join(fs.realpathSync(cur), ...tail);
  } catch {
    return abs;
  }
}

/** Sanitize a group folder into a Docker-name-safe identifier. */
export function safeContainerName(prefix: string, groupFolder: string): string {
  const safe = groupFolder.replace(/[^a-zA-Z0-9-]/g, '-');
  return `${prefix}-${safe}`;
}
