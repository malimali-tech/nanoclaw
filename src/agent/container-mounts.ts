// src/agent/container-mounts.ts
//
// Computes per-chat container bind mounts. Ported from
// `9382e70~1:src/container-runner.ts:buildVolumeMounts`, simplified for the
// pi-mono-on-host architecture:
//
//   • No /workspace/ipc — extension tools (send_message, schedule_task) run
//     in-process on the host, no IPC needed.
//   • No /home/node/.claude — claude-code CLI is no longer in-container.
//   • No /workspace/project/store — the host owns the DB; container has no
//     reason to touch it.
//   • Per-message containers became per-chat containers; mounts are
//     decided once per chat at container create time, not on each message.

import fs from 'fs';
import path from 'path';
import { GROUPS_DIR } from '../config.js';
import { resolveGroupFolderPath } from '../group-folder.js';
import { globalSkillsDirs } from './global-skills.js';

export interface VolumeMount {
  hostPath: string;
  containerPath: string;
  readonly: boolean;
}

/** Standard container path conventions. Kept stable so the agent's mental
 *  model of "where am I" doesn't drift between code edits. */
export const CONTAINER_PATHS = {
  group: '/workspace/group',
  global: '/workspace/global',
  project: '/workspace/project',
  /** lark-cli config + secret store — see Dockerfile's
   *  LARKSUITE_CLI_CONFIG_DIR / LARKSUITE_CLI_DATA_DIR. Shared across all
   *  per-chat containers via a host-side bind, so a single
   *  `lark-cli auth login` flow grants every chat the same UAT. */
  larkCliState: '/workspace/lark-cli',
} as const;

/**
 * Host-side directory that backs `CONTAINER_PATHS.larkCliState`. Holds:
 *   - config/config.json — appId / brand / profile metadata
 *   - data/lark-cli/     — XDG data dir, encrypted secrets (appSecret + UAT)
 *
 * Created on demand by `ensureLarkCliStateDir`. Single global directory
 * (not per-chat) so all chats share one Feishu identity, matching the
 * single-account FEISHU_APP_ID/SECRET model nanoclaw uses elsewhere.
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
 * Compute the bind mount set for a given chat. The result is what gets
 * passed to `docker run -v ...` at container create time.
 *
 * Non-main chats see only their own group folder (RW) and the shared
 * global folder (RO). Main additionally gets the project repo (RO) for
 * self-modification, with .env shadowed via /dev/null.
 */
export function buildVolumeMounts(
  groupFolder: string,
  isMain: boolean,
): VolumeMount[] {
  const mounts: VolumeMount[] = [];
  const groupDir = resolveGroupFolderPath(groupFolder);

  // Per-chat working directory — always RW for the owning chat.
  mounts.push({
    hostPath: groupDir,
    containerPath: CONTAINER_PATHS.group,
    readonly: false,
  });

  // Shared global memory. Non-main: read-only (so Bob can't rewrite
  // shared notes that Alice wrote). Main: writable.
  const globalDir = path.join(GROUPS_DIR, 'global');
  if (fs.existsSync(globalDir)) {
    mounts.push({
      hostPath: globalDir,
      containerPath: CONTAINER_PATHS.global,
      readonly: !isMain,
    });
  }

  if (isMain) {
    // Main can read NanoClaw's own source for self-modification — but only
    // read. Writable paths the agent legitimately needs (group folder,
    // global) are mounted separately above. RO on the project root means
    // the agent can't ship a code change that takes effect on next restart.
    const projectRoot = process.cwd();
    mounts.push({
      hostPath: projectRoot,
      containerPath: CONTAINER_PATHS.project,
      readonly: true,
    });

    // Shadow .env so the readable project root doesn't leak credentials.
    // /dev/null mounted as a file makes the path appear empty.
    const envFile = path.join(projectRoot, '.env');
    if (fs.existsSync(envFile)) {
      mounts.push({
        hostPath: '/dev/null',
        containerPath: `${CONTAINER_PATHS.project}/.env`,
        readonly: true,
      });
    }
  }

  // Global skills bind-mounted at their host paths so bash sees them at
  // the exact path pi advertised to the LLM in <available_skills>.
  // Read-only — skills are operator-managed (`npx skills`, `pi skills`),
  // not chat-managed. If a skill calls `python3 scripts/x.py` it works
  // iff python3 is in the image; missing runtimes are an image concern,
  // not a mount concern.
  for (const dir of globalSkillsDirs()) {
    mounts.push({ hostPath: dir, containerPath: dir, readonly: true });
  }

  // lark-cli config + secret store — RW so the agent's `lark-cli config
  // init` / `auth login` writes persist across container restarts and
  // are visible to every chat's container. Single shared directory; the
  // app-credential model is single-account.
  const larkState = ensureLarkCliStateDir();
  mounts.push({
    hostPath: larkState,
    containerPath: CONTAINER_PATHS.larkCliState,
    readonly: false,
  });

  return mounts;
}

/** Sanitize a group folder into a Docker-name-safe identifier. */
export function safeContainerName(prefix: string, groupFolder: string): string {
  const safe = groupFolder.replace(/[^a-zA-Z0-9-]/g, '-');
  return `${prefix}-${safe}`;
}
