// src/agent/diagnostics.ts
//
// Read-only runtime self-check. Powers the chat-side /diagnostics command
// and, by extension, anything that wants a one-shot snapshot of "is the
// agent's tool runtime healthy for this chat right now?". All probes are
// cheap (≤ a few seconds), idempotent, and safe to call concurrently.

import { spawnSync } from 'node:child_process';
import {
  CONTAINER_RUNTIME_BIN,
  containerExists,
  containerRunning,
} from './container-runtime.js';
import { safeContainerName } from './container-mounts.js';
import { dockerRuntimeConfig, loadSandboxConfig } from './sandbox-config.js';
import { currentRuntime } from './tool-runtime.js';

export interface ChatDiagnostics {
  runtime: 'docker' | 'sandbox-exec' | 'off';
  /** Docker-only fields. Undefined for non-docker runtimes. */
  docker?: {
    daemonReachable: boolean;
    image: string;
    imageExists: boolean;
    containerName: string;
    containerExists: boolean;
    containerRunning: boolean;
  };
}

/**
 * Quick `docker info` probe with a short timeout — distinct from
 * `ensureContainerRuntimeRunning` (which throws on failure). Here we want
 * a yes/no for reporting.
 */
function dockerDaemonReachable(): boolean {
  const result = spawnSync(
    CONTAINER_RUNTIME_BIN,
    ['info', '--format', '{{.ID}}'],
    {
      stdio: 'pipe',
      timeout: 4000,
    },
  );
  return !result.error && result.status === 0;
}

function dockerImageExists(image: string): boolean {
  const result = spawnSync(CONTAINER_RUNTIME_BIN, ['image', 'inspect', image], {
    stdio: 'pipe',
    timeout: 4000,
  });
  return result.status === 0;
}

/**
 * Snapshot the runtime health for one chat. Never throws — every probe
 * resolves to a boolean (or undefined-section for runtimes that don't
 * apply). Suitable for direct rendering into a chat reply.
 */
export function probeChatDiagnostics(groupFolder: string): ChatDiagnostics {
  const runtime = currentRuntime();
  if (runtime !== 'docker') {
    return { runtime };
  }

  const cfg = loadSandboxConfig();
  const docker = dockerRuntimeConfig(cfg);
  const containerName = safeContainerName(
    docker.containerNamePrefix,
    groupFolder,
  );
  const daemonReachable = dockerDaemonReachable();
  // Image / container probes require the daemon. Short-circuit when it's
  // unreachable so we don't spend 4s timing out per probe.
  if (!daemonReachable) {
    return {
      runtime,
      docker: {
        daemonReachable: false,
        image: docker.image,
        imageExists: false,
        containerName,
        containerExists: false,
        containerRunning: false,
      },
    };
  }
  return {
    runtime,
    docker: {
      daemonReachable: true,
      image: docker.image,
      imageExists: dockerImageExists(docker.image),
      containerName,
      containerExists: containerExists(containerName),
      containerRunning: containerRunning(containerName),
    },
  };
}
