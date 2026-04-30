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
} as const;

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

  return mounts;
}

/** Sanitize a group folder into a Docker-name-safe identifier. */
export function safeContainerName(prefix: string, groupFolder: string): string {
  const safe = groupFolder.replace(/[^a-zA-Z0-9-]/g, '-');
  return `${prefix}-${safe}`;
}
