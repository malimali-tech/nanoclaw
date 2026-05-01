// src/agent/path-guard.ts
//
// Validates host paths supplied by agent-controlled tool inputs against a
// per-chat allowlist. The bash tool gets kernel-level isolation via the
// container; the host-side fs tools (Read/Write/Edit/Grep/Find/Ls) reach
// the same files through the bind mount but execute as the NanoClaw
// process — so we need an in-process check before each fs call.
//
// Why not put fs tools in the container too? Because forwarding pi's
// Read/Write/Edit through `docker exec` corrupts binary files (NUL bytes
// break stdout) and breaks image previews — the same regression that got
// the previous Docker tool sandbox PR reverted. Keeping fs on host means
// we own that path correctness; a path check is the price.

import fs from 'fs';
import path from 'path';
import { GROUPS_DIR } from '../config.js';
import { resolveGroupFolderPath } from '../group-folder.js';
import { globalSkillsDirs } from './global-skills.js';

export interface AllowedRoot {
  /** Absolute, realpath-resolved root directory. */
  root: string;
  /** True iff the agent may write under this root. */
  writable: boolean;
}

export interface PathGuard {
  assertReadable(p: string): void;
  assertWritable(p: string): void;
  /** For diagnostics / logging. */
  describe(): string;
}

/**
 * Build the allowed-root set for a chat. Mirrors what
 * container-mounts.ts bind-mounts into the bash container, so the agent
 * sees a consistent surface across bash and host-fs tools.
 *
 * groupCwd is included so tool calls with absolute paths beneath it
 * resolve correctly (paths like /workspace/group/foo aren't valid host
 * paths — agents must use relative or host-absolute paths to pi's fs
 * tools).
 */
export function buildAllowedRoots(
  groupFolder: string,
  isMain: boolean,
): AllowedRoot[] {
  const roots: AllowedRoot[] = [];

  const groupDir = realIfExists(resolveGroupFolderPath(groupFolder));
  roots.push({ root: groupDir, writable: true });

  const globalDir = path.join(GROUPS_DIR, 'global');
  if (fs.existsSync(globalDir)) {
    roots.push({ root: realIfExists(globalDir), writable: isMain });
  }

  if (isMain) {
    // Main can read project source; never write through host-fs tools (the
    // container mount is also RO, so writes would fail there too — keep
    // the two surfaces in lockstep).
    roots.push({ root: realIfExists(process.cwd()), writable: false });
  }

  // Global skills directories — every chat needs to Read SKILL.md and
  // skill assets/scripts. Read-only: skills are managed by the operator
  // out-of-band via `npx skills` / `pi skills`; the agent must not
  // mutate them from inside a chat.
  for (const dir of globalSkillsDirs()) {
    roots.push({ root: realIfExists(dir), writable: false });
  }

  return roots;
}

export function makePathGuard(groupFolder: string, isMain: boolean): PathGuard {
  const groupDir = resolveGroupFolderPath(groupFolder);
  const roots = buildAllowedRoots(groupFolder, isMain);

  function resolveAgentPath(p: string): string {
    // Treat relative paths as anchored to the chat's group folder, just
    // like the bash container's --workdir. Absolute paths are used as-is
    // (then validated against the allowed roots).
    const abs = path.isAbsolute(p) ? p : path.join(groupDir, p);
    return realIfExists(abs);
  }

  function findRoot(absPath: string): AllowedRoot | undefined {
    return roots.find(
      (r) => absPath === r.root || absPath.startsWith(r.root + path.sep),
    );
  }

  return {
    assertReadable(p) {
      const abs = resolveAgentPath(p);
      const hit = findRoot(abs);
      if (!hit) {
        throw new Error(
          `path-guard: refusing to read "${p}" — outside chat workspace ` +
            `(allowed: ${roots.map((r) => r.root).join(', ')})`,
        );
      }
    },
    assertWritable(p) {
      const abs = resolveAgentPath(p);
      const hit = findRoot(abs);
      if (!hit) {
        throw new Error(
          `path-guard: refusing to write "${p}" — outside chat workspace ` +
            `(allowed: ${roots.map((r) => r.root).join(', ')})`,
        );
      }
      if (!hit.writable) {
        throw new Error(
          `path-guard: refusing to write "${p}" — root ${hit.root} is read-only`,
        );
      }
    },
    describe() {
      return roots
        .map((r) => `${r.writable ? 'rw' : 'ro'}:${r.root}`)
        .join(' ');
    },
  };
}

/**
 * fs.realpathSync if the path exists, else the lexically-normalized
 * absolute form. Lets us validate writes to not-yet-created files
 * (Write tool's main use case) while still defeating ../ tricks.
 *
 * For the not-yet-existing case we resolve the parent directory's
 * realpath then rejoin the basename — so a symlinked `groups/alice` →
 * `/elsewhere/alice` followed by writing `groups/alice/new.md` resolves
 * correctly even when `new.md` doesn't exist yet.
 */
function realIfExists(p: string): string {
  const abs = path.resolve(p);
  if (fs.existsSync(abs)) {
    try {
      return fs.realpathSync(abs);
    } catch {
      return abs;
    }
  }
  // Walk up until an ancestor exists, realpath that, then re-attach the
  // missing tail.
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
