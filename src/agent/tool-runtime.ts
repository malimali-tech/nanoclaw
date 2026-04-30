// src/agent/tool-runtime.ts
//
// Single owner of "how do agent tool calls reach the underlying OS".
// Encapsulates the runtime selection (docker | sandbox-exec | off) so the
// extension layer only asks "give me the per-chat tool ops" and doesn't
// branch on runtime itself. Lifecycle hooks (init / dispose-chat / shutdown)
// keep pool and SandboxManager state from leaking across modes.

import { SandboxManager } from '@anthropic-ai/sandbox-runtime';
import path from 'node:path';
import type {
  BashOperations,
  EditOperations,
  FindOperations,
  GrepOperations,
  LsOperations,
  ReadOperations,
  WriteOperations,
} from '@mariozechner/pi-coding-agent';
import { GROUPS_DIR } from '../config.js';
import { logger } from '../logger.js';
import {
  dockerRuntimeConfig,
  loadSandboxConfig,
  type Runtime,
  type SandboxConfig,
} from './sandbox-config.js';
import { ContainerPool } from './container-pool.js';
import {
  ensureContainerRuntimeRunning,
  ensureImageExists,
} from './container-runtime.js';
import { createDockerBashOps } from './docker-bash.js';
import { createSandboxedBashOps } from './sandbox-bash.js';
import { makePathGuard } from './path-guard.js';
import {
  makeEditOps,
  makeFindOps,
  makeGrepOps,
  makeLsOps,
  makeReadOps,
  makeWriteOps,
} from './host-fs-tools.js';

export interface ChatToolBindings {
  bash: BashOperations | null;
  read: ReadOperations | null;
  write: WriteOperations | null;
  edit: EditOperations | null;
  grep: GrepOperations | null;
  find: FindOperations | null;
  ls: LsOperations | null;
}

const log = (m: string) => logger.info(`[tool-runtime] ${m}`);

let runtime: Runtime = 'off';
let containerPool: ContainerPool | null = null;
let initialized = false;

/**
 * Decide and initialize the tool runtime once for the process. Called from
 * src/index.ts before the first AgentSession is built.
 *
 * Fail-fast on docker: if the daemon or image is missing, we'd rather the
 * user know up front than discover it on first inbound message.
 */
export async function initToolRuntime(): Promise<void> {
  if (initialized) return;
  const cfg: SandboxConfig = loadSandboxConfig();
  runtime = resolveRuntime(cfg);
  log(`runtime selected: ${runtime}`);

  if (runtime === 'docker') {
    ensureContainerRuntimeRunning();
    const docker = dockerRuntimeConfig(cfg);
    ensureImageExists(docker.image);
    containerPool = new ContainerPool(docker);
    log(`docker runtime ready (image=${docker.image})`);
  } else if (runtime === 'sandbox-exec') {
    if (process.platform !== 'darwin' && process.platform !== 'linux') {
      log(`sandbox-exec unsupported on ${process.platform}; bash unsandboxed`);
    } else {
      await SandboxManager.initialize(cfg);
      const probe = await SandboxManager.wrapWithSandbox('true');
      const expected = process.platform === 'darwin' ? 'sandbox-exec' : 'bwrap';
      if (!probe.includes(expected)) {
        throw new Error(
          `sandbox-exec self-check failed: wrapWithSandbox('true') did not include "${expected}"; ` +
            `bash would run unsandboxed. wrapper output: ${probe.slice(0, 200)}`,
        );
      }
      log(`sandbox-exec initialized (${expected})`);
    }
  }

  initialized = true;
}

function resolveRuntime(cfg: SandboxConfig): Runtime {
  if (cfg.runtime) return cfg.runtime;
  // Backwards compatibility for old configs that only set `enabled`.
  return cfg.enabled === false ? 'off' : 'docker';
}

/**
 * Return the per-chat tool bindings for the current runtime. Each call
 * may produce a fresh container or path guard instance — callers should
 * cache per session, not per call.
 *
 * For docker mode this triggers container creation if not already running
 * (idempotent inside ContainerPool.ensure).
 */
export function getChatToolBindings(
  groupFolder: string,
  isMain: boolean,
): ChatToolBindings {
  if (runtime === 'docker') {
    if (!containerPool) {
      throw new Error(
        'tool-runtime: docker mode but ContainerPool missing; initToolRuntime not called?',
      );
    }
    const containerName = containerPool.ensure(groupFolder, isMain);
    const guard = makePathGuard(groupFolder, isMain);
    const groupCwd = path.join(GROUPS_DIR, groupFolder);
    return {
      bash: createDockerBashOps({
        containerName: () => containerName,
        groupFolder,
      }),
      read: makeReadOps(guard),
      write: makeWriteOps(guard),
      edit: makeEditOps(guard),
      grep: makeGrepOps(guard),
      find: makeFindOps(guard, groupCwd),
      ls: makeLsOps(guard),
    };
  }

  if (runtime === 'sandbox-exec') {
    return {
      bash: createSandboxedBashOps(),
      read: null,
      write: null,
      edit: null,
      grep: null,
      find: null,
      ls: null,
    };
  }

  // 'off' — pi defaults all the way through.
  return {
    bash: null,
    read: null,
    write: null,
    edit: null,
    grep: null,
    find: null,
    ls: null,
  };
}

/** Per-chat teardown: dispose container in docker mode; nothing else cares. */
export function disposeChatRuntime(groupFolder: string): void {
  if (runtime === 'docker' && containerPool) {
    containerPool.dispose(groupFolder);
  }
}

/** Process-wide teardown. */
export async function shutdownToolRuntime(): Promise<void> {
  if (containerPool) {
    containerPool.disposeAll();
    containerPool = null;
  }
  if (runtime === 'sandbox-exec') {
    try {
      await SandboxManager.reset();
    } catch (err) {
      log(
        `SandboxManager.reset failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  initialized = false;
  runtime = 'off';
}

/** Inspection only — used by extension.ts to decide whether to override. */
export function currentRuntime(): Runtime {
  return runtime;
}
