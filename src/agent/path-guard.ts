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
//
// The allowed-root set is *derived* from MountPolicy so the host-fs view
// and the container bind-mount view are guaranteed to agree.

import path from 'path';
import { resolveGroupFolderPath } from '../group-folder.js';
import {
  computeMountPolicy,
  realIfExists,
  type HostRoot,
} from './mount-policy.js';

export type { HostRoot as AllowedRoot } from './mount-policy.js';

export interface PathGuard {
  assertReadable(p: string): void;
  assertWritable(p: string): void;
  /** For diagnostics / logging. */
  describe(): string;
}

/**
 * Build the allowed-root set for a chat. Derived from `computeMountPolicy`
 * so the host-fs view and the container bind-mount view stay in lockstep.
 */
export function buildAllowedRoots(
  groupFolder: string,
  isMain: boolean,
): HostRoot[] {
  return [...computeMountPolicy(groupFolder, isMain).hostRoots()];
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

  function findRoot(absPath: string): HostRoot | undefined {
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
