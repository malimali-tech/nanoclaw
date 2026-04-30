// src/agent/docker-bash.ts
//
// BashOperations that forward every bash invocation into a per-chat
// container via `docker exec`. The container is the "tool jail" — bash
// can only see what's bind-mounted in (group folder, global, optionally
// project for main), so cross-chat reads are physically prevented by the
// kernel rather than enforced by a path ACL.

import { spawn } from 'node:child_process';
import path from 'node:path';
import type { BashOperations } from '@mariozechner/pi-coding-agent';
import { GROUPS_DIR } from '../config.js';
import { CONTAINER_RUNTIME_BIN } from './container-runtime.js';
import { CONTAINER_PATHS } from './container-mounts.js';

/**
 * Translate a host cwd into the container path it's mounted at, so
 * pi-mono's "cwd" parameter still has its expected effect (commands run
 * where the agent thinks they do).
 *
 * Pi calls exec(command, cwd, opts) with the host cwd it set on the bash
 * tool — typically `<repo>/groups/<folder>`. That path is bind-mounted to
 * /workspace/group inside the container. If the cwd is somewhere else
 * (e.g. an outer pi build process), we fall back to /workspace/group too;
 * any path outside the chat's own group folder is just not visible to bash.
 */
function mapHostCwd(hostCwd: string, groupFolder: string): string {
  const groupHost = path.join(GROUPS_DIR, groupFolder);
  if (hostCwd === groupHost) return CONTAINER_PATHS.group;
  // Allow a sub-cwd inside the group folder to be honored.
  if (hostCwd.startsWith(groupHost + path.sep)) {
    const rel = path.relative(groupHost, hostCwd);
    return path.posix.join(CONTAINER_PATHS.group, rel.split(path.sep).join('/'));
  }
  // Anything outside the group folder is silently re-anchored to the
  // group root. Bash can't escape there anyway since the host cwd isn't
  // bind-mounted in.
  return CONTAINER_PATHS.group;
}

export function createDockerBashOps(args: {
  containerName: () => string;
  groupFolder: string;
}): BashOperations {
  const { containerName, groupFolder } = args;

  return {
    exec(command, cwd, opts) {
      const { onData, signal, timeout } = opts;
      const containerCwd = mapHostCwd(cwd, groupFolder);
      const dockerArgs = [
        'exec',
        '-i',
        '--workdir',
        containerCwd,
        containerName(),
        'bash',
        '-c',
        command,
      ];

      return new Promise<{ exitCode: number | null }>((resolve, reject) => {
        const child = spawn(CONTAINER_RUNTIME_BIN, dockerArgs, {
          stdio: ['ignore', 'pipe', 'pipe'],
        });

        let timedOut = false;
        let timeoutHandle: NodeJS.Timeout | undefined;
        if (timeout !== undefined && timeout > 0) {
          timeoutHandle = setTimeout(() => {
            timedOut = true;
            child.kill('SIGKILL');
          }, timeout * 1000);
        }

        child.stdout?.on('data', onData);
        child.stderr?.on('data', onData);

        const onAbort = () => child.kill('SIGKILL');
        signal?.addEventListener('abort', onAbort, { once: true });

        child.on('error', (err) => {
          if (timeoutHandle) clearTimeout(timeoutHandle);
          signal?.removeEventListener('abort', onAbort);
          reject(err);
        });

        child.on('close', (code) => {
          if (timeoutHandle) clearTimeout(timeoutHandle);
          signal?.removeEventListener('abort', onAbort);
          if (signal?.aborted) {
            reject(new Error('aborted'));
          } else if (timedOut) {
            reject(new Error(`timeout:${timeout}`));
          } else {
            resolve({ exitCode: code });
          }
        });
      });
    },
  };
}
