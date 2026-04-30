// src/agent/sandbox-bash.ts
//
// Wraps every bash command via SandboxManager.wrapWithSandbox before spawning,
// so the policy installed by SandboxManager.initialize() is actually enforced.
//
// pi-coding-agent's default `createLocalBashOperations` does NOT consult
// SandboxManager — it spawns bash directly. Without this module, the policy
// in config/sandbox.json would be loaded but never applied.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { SandboxManager } from '@anthropic-ai/sandbox-runtime';
import type { BashOperations } from '@mariozechner/pi-coding-agent';

let sandboxedOps: BashOperations | null = null;

export function setSandboxedBashOps(ops: BashOperations | null): void {
  sandboxedOps = ops;
}

export function getSandboxedBashOps(): BashOperations | null {
  return sandboxedOps;
}

export function createSandboxedBashOps(): BashOperations {
  return {
    exec(command, cwd, { onData, signal, timeout, env }) {
      if (!existsSync(cwd)) {
        return Promise.reject(
          new Error(`Working directory does not exist: ${cwd}`),
        );
      }

      return new Promise(async (resolve, reject) => {
        let wrappedCommand: string;
        try {
          wrappedCommand = await SandboxManager.wrapWithSandbox(command);
        } catch (err) {
          reject(err);
          return;
        }

        const child = spawn('bash', ['-c', wrappedCommand], {
          cwd,
          detached: true,
          env: env ?? process.env,
          stdio: ['ignore', 'pipe', 'pipe'],
        });

        let timedOut = false;
        let timeoutHandle: NodeJS.Timeout | undefined;
        if (timeout !== undefined && timeout > 0) {
          timeoutHandle = setTimeout(() => {
            timedOut = true;
            if (child.pid) {
              try {
                process.kill(-child.pid, 'SIGKILL');
              } catch {
                child.kill('SIGKILL');
              }
            }
          }, timeout * 1000);
        }

        child.stdout?.on('data', onData);
        child.stderr?.on('data', onData);

        const onAbort = () => {
          if (child.pid) {
            try {
              process.kill(-child.pid, 'SIGKILL');
            } catch {
              child.kill('SIGKILL');
            }
          }
        };
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
