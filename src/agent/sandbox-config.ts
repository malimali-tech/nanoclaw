import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import type { SandboxRuntimeConfig } from '@anthropic-ai/sandbox-runtime';

export type Runtime = 'docker' | 'sandbox-exec' | 'off';

export interface DockerRuntimeConfig {
  image: string;
  containerNamePrefix: string;
  stopTimeoutSec: number;
}

export interface SandboxConfig extends SandboxRuntimeConfig {
  /** Selects which tool runtime to use. Default: docker. */
  runtime?: Runtime;
  /** Docker-specific knobs (only consulted when runtime === 'docker'). */
  docker?: DockerRuntimeConfig;
  /**
   * Legacy alias for `runtime: 'off'`. When `enabled === false`, sandbox-exec
   * (and only sandbox-exec) is bypassed. Kept for older configs; prefer
   * `runtime` explicitly.
   */
  enabled?: boolean;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PATH = path.resolve(
  __dirname,
  '../../config/sandbox.default.json',
);

if (!fs.existsSync(DEFAULT_PATH)) {
  throw new Error(
    `[sandbox-config] Built-in default config missing at ${DEFAULT_PATH}. ` +
      `Build layout may be wrong or config/sandbox.default.json was not shipped.`,
  );
}

// Single, process-wide sandbox policy. Loaded once at startup.
//
// Per-group overrides (groups/<g>/.pi/sandbox.json) were removed: they let an
// agent rewrite the policy applied to its own bash tool — a sandbox whose
// rules are writable by the sandboxed process is not a sandbox.
export function loadSandboxConfig(): SandboxConfig {
  const cfg = JSON.parse(
    fs.readFileSync(DEFAULT_PATH, 'utf-8'),
  ) as SandboxConfig;
  // Default runtime if missing in older configs.
  if (!cfg.runtime) {
    cfg.runtime = cfg.enabled === false ? 'off' : 'docker';
  }
  return cfg;
}

const DEFAULT_DOCKER: DockerRuntimeConfig = {
  image: 'nanoclaw-tool:latest',
  containerNamePrefix: 'nanoclaw-tool',
  stopTimeoutSec: 1,
};

export function dockerRuntimeConfig(cfg: SandboxConfig): DockerRuntimeConfig {
  return { ...DEFAULT_DOCKER, ...(cfg.docker ?? {}) };
}
