// src/agent/container-pool.ts
//
// Per-chat container lifecycle. One container per registered chat, named
// `<prefix>-<safe-folder>` (deterministic so cross-restart reattachment
// works). Created on demand, removed on `dispose`.
//
// Lifecycle is intentionally aligned with AgentSession (run.ts:SessionPool):
// containers spin up when the session is built and tear down when the
// session is evicted by idle TTL or process shutdown. This keeps the
// "what's currently warm" invariant single-sourced — there's no risk of a
// session running against a missing container or vice versa.

import { spawnSync } from 'child_process';
import {
  CONTAINER_RUNTIME_BIN,
  bindMountArg,
  containerExists,
  containerRunning,
  hostGatewayArgs,
  stopAndRemoveContainer,
} from './container-runtime.js';
import { buildVolumeMounts, safeContainerName } from './container-mounts.js';
import type { DockerRuntimeConfig } from './sandbox-config.js';
import { logger } from '../logger.js';

interface PoolEntry {
  name: string;
  groupFolder: string;
  isMain: boolean;
}

const log = (m: string) => logger.info(`[container-pool] ${m}`);

export class ContainerPool {
  private entries = new Map<string, PoolEntry>();

  constructor(private docker: DockerRuntimeConfig) {}

  /**
   * Idempotently ensure a container exists and is running for this chat.
   * Returns the container name (caller uses it as the `docker exec` target).
   *
   * If a container of the same name exists from a previous NanoClaw run,
   * we reuse it — its bind-mounts are baked in at create time and the
   * group's mount set hasn't changed, so reuse is safe.
   */
  ensure(groupFolder: string, isMain: boolean): string {
    const cached = this.entries.get(groupFolder);
    if (cached) return cached.name;

    const name = safeContainerName(
      this.docker.containerNamePrefix,
      groupFolder,
    );

    if (containerExists(name)) {
      if (!containerRunning(name)) {
        log(`reusing existing container ${name} (was stopped, starting)`);
        const start = spawnSync(CONTAINER_RUNTIME_BIN, ['start', name], {
          stdio: 'pipe',
          timeout: 10000,
        });
        if (start.status !== 0) {
          // Stale image / mount mismatch / orphaned name — wipe and recreate.
          log(`start failed, removing stale ${name}`);
          stopAndRemoveContainer(name, this.docker.stopTimeoutSec);
          this.create(name, groupFolder, isMain);
        }
      } else {
        log(`reusing running container ${name}`);
      }
    } else {
      this.create(name, groupFolder, isMain);
    }

    this.entries.set(groupFolder, { name, groupFolder, isMain });
    return name;
  }

  private create(name: string, groupFolder: string, isMain: boolean): void {
    const mounts = buildVolumeMounts(groupFolder, isMain);
    const args: string[] = [
      'run',
      '-d',
      '--name',
      name,
      // Match host UID/GID so bind-mounted writes are owned by the user, not
      // root. Falls back to image's default user when getuid is unavailable
      // (e.g. native Windows).
      ...userArgs(),
      ...hostGatewayArgs(),
      ...mounts.flatMap((m) =>
        bindMountArg(m.hostPath, m.containerPath, m.readonly),
      ),
      this.docker.image,
      'sleep',
      'infinity',
    ];

    const result = spawnSync(CONTAINER_RUNTIME_BIN, args, {
      stdio: 'pipe',
      timeout: 30000,
    });

    if (result.status !== 0) {
      const stderr = result.stderr?.toString().trim() ?? '';
      throw new Error(
        `Failed to create container ${name}: ${stderr || `exit ${result.status}`}`,
      );
    }

    log(`created ${name} (mounts: ${mounts.length})`);
  }

  /**
   * Stop and remove the container for this chat. Called when the
   * AgentSession is evicted by idle TTL.
   */
  dispose(groupFolder: string): void {
    const entry = this.entries.get(groupFolder);
    if (!entry) return;
    this.entries.delete(groupFolder);
    try {
      stopAndRemoveContainer(entry.name, this.docker.stopTimeoutSec);
      log(`disposed ${entry.name}`);
    } catch (err) {
      log(
        `dispose ${entry.name} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** Tear down every container we own. Called on process shutdown. */
  disposeAll(): void {
    const folders = [...this.entries.keys()];
    for (const f of folders) this.dispose(f);
  }

  /** Look up the container name for a chat (or undefined if not running). */
  nameFor(groupFolder: string): string | undefined {
    return this.entries.get(groupFolder)?.name;
  }

  size(): number {
    return this.entries.size;
  }
}

function userArgs(): string[] {
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  if (uid == null || gid == null) return [];
  if (uid === 0) return []; // running NanoClaw as root: keep image's default user
  // Override HOME explicitly: any host UID that doesn't match an /etc/passwd
  // entry inside the container (typically the case for macOS hosts with
  // UID 501) defaults HOME=/, which is root-owned and breaks anything that
  // wants to mkdir under $HOME (chromium socket dir, npm cache, etc.).
  // /home/node is chmod 777 in the image so this is safe under any UID.
  return [
    '--user',
    `${uid}:${gid}`,
    '-e',
    'HOME=/home/node',
    '-e',
    'XDG_CACHE_HOME=/home/node/.cache',
    '-e',
    'XDG_RUNTIME_DIR=/tmp',
  ];
}
