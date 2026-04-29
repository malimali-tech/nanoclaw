import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import type { SandboxRuntimeConfig } from '@anthropic-ai/sandbox-runtime';

export interface SandboxConfig extends SandboxRuntimeConfig {
  enabled?: boolean;
  /** Which sandbox backend to use. Defaults to `sandbox-runtime` (current behavior). */
  runtime?: 'docker' | 'sandbox-runtime' | 'off';
  /** Settings for `runtime: docker`. Ignored otherwise. */
  docker?: { containerName?: string; image?: string };
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

function readJsonOrEmpty(p: string): Partial<SandboxConfig> {
  try {
    return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf-8')) : {};
  } catch {
    return {};
  }
}

// Top-level keys replaced wholesale; nested `network`/`filesystem` are merged
// shallowly (one level). Leaf arrays like allowedDomains and denyWrite are
// REPLACED by the override, not concatenated. To extend a default list, the
// project config must include the defaults explicitly.
function mergeSandboxConfig(
  a: SandboxConfig,
  b: Partial<SandboxConfig>,
): SandboxConfig {
  const out: SandboxConfig = { ...a };
  if (b.enabled !== undefined) out.enabled = b.enabled;
  if (b.runtime !== undefined) out.runtime = b.runtime;
  if (b.docker) out.docker = { ...a.docker, ...b.docker };
  if (b.network) out.network = { ...a.network, ...b.network };
  if (b.filesystem) out.filesystem = { ...a.filesystem, ...b.filesystem };
  return out;
}

export function loadSandboxConfig(groupCwd: string): SandboxConfig {
  const base = readJsonOrEmpty(DEFAULT_PATH) as SandboxConfig;
  const project = readJsonOrEmpty(path.join(groupCwd, '.pi', 'sandbox.json'));
  return mergeSandboxConfig(base, project);
}
