// src/agent/container-runtime.ts
//
// Thin abstraction over the container runtime CLI. Pi-mono runs the LLM loop
// in-process on the host so we no longer need credential-proxy plumbing —
// what's left is just "find docker, talk to docker, stop containers".
//
// Ported and stripped down from `9382e70~1:src/container-runtime.ts`.

import { execFileSync, spawnSync } from 'child_process';
import { logger } from '../logger.js';

/** Runtime binary on $PATH. */
export const CONTAINER_RUNTIME_BIN = 'docker';

/**
 * Verify the container runtime daemon is reachable. Throws (with an
 * actionable error string) if not — the caller is expected to fail-fast.
 *
 * Doesn't try to start Docker Desktop / dockerd; that's a deliberate user
 * action and we don't want NanoClaw second-guessing it.
 */
export function ensureContainerRuntimeRunning(): void {
  const result = spawnSync(CONTAINER_RUNTIME_BIN, ['info'], {
    stdio: 'pipe',
    timeout: 10000,
  });
  if (result.error || result.status !== 0) {
    const stderr = result.stderr?.toString() ?? '';
    throw new Error(
      `Container runtime '${CONTAINER_RUNTIME_BIN}' is not reachable.\n` +
        `  • Is Docker Desktop / dockerd running?\n` +
        `  • Is '${CONTAINER_RUNTIME_BIN}' on PATH?\n` +
        (stderr ? `Last stderr: ${stderr.trim()}\n` : ''),
    );
  }
  logger.debug('Container runtime reachable');
}

/** Verify the named image exists locally. */
export function ensureImageExists(image: string): void {
  const result = spawnSync(
    CONTAINER_RUNTIME_BIN,
    ['image', 'inspect', image],
    { stdio: 'pipe', timeout: 10000 },
  );
  if (result.status !== 0) {
    throw new Error(
      `Container image '${image}' not found locally.\n` +
        `Build it with:\n` +
        `  ./container/build.sh\n`,
    );
  }
}

/**
 * Returns true if a container with this name exists (any state).
 * Idempotent and side-effect-free.
 */
export function containerExists(name: string): boolean {
  const result = spawnSync(
    CONTAINER_RUNTIME_BIN,
    ['inspect', '--format', '{{.State.Status}}', name],
    { stdio: 'pipe', timeout: 5000 },
  );
  return result.status === 0;
}

/** True iff the container exists AND its state is "running". */
export function containerRunning(name: string): boolean {
  const result = spawnSync(
    CONTAINER_RUNTIME_BIN,
    ['inspect', '--format', '{{.State.Running}}', name],
    { stdio: 'pipe', timeout: 5000 },
  );
  if (result.status !== 0) return false;
  return result.stdout.toString().trim() === 'true';
}

/**
 * Stop and remove a container by name. Validates the name to keep this
 * shell-injection-free (we use execFileSync so the command path can't
 * inject, but the name itself flows in from caller-controlled context).
 */
export function stopAndRemoveContainer(
  name: string,
  stopTimeoutSec: number,
): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name)) {
    throw new Error(`Invalid container name: ${name}`);
  }
  // `docker rm -f` is "stop + rm" in one call but doesn't honor a graceful
  // timeout. Two-step keeps `sleep infinity` PID 1 a chance to exit cleanly,
  // which matters mostly for log buffering.
  try {
    execFileSync(
      CONTAINER_RUNTIME_BIN,
      ['stop', '-t', String(stopTimeoutSec), name],
      { stdio: 'pipe', timeout: (stopTimeoutSec + 5) * 1000 },
    );
  } catch {
    /* may already be stopped */
  }
  try {
    execFileSync(CONTAINER_RUNTIME_BIN, ['rm', '-f', name], {
      stdio: 'pipe',
      timeout: 5000,
    });
  } catch {
    /* may already be gone */
  }
}

/** Hostname containers use to reach the host. */
export const CONTAINER_HOST_GATEWAY = 'host.docker.internal';

/** Extra `docker run` args to make `host.docker.internal` resolvable. */
export function hostGatewayArgs(): string[] {
  if (process.platform === 'linux') {
    return ['--add-host=host.docker.internal:host-gateway'];
  }
  return [];
}

/** Build `-v hostPath:containerPath[:ro]` args. */
export function bindMountArg(
  hostPath: string,
  containerPath: string,
  readonly: boolean,
): string[] {
  return ['-v', `${hostPath}:${containerPath}${readonly ? ':ro' : ''}`];
}
