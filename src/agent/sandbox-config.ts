import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import type { SandboxRuntimeConfig } from '@anthropic-ai/sandbox-runtime';

export interface SandboxConfig extends SandboxRuntimeConfig {
  enabled?: boolean;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PATH = path.resolve(__dirname, '../../config/sandbox.default.json');

function readJsonOrEmpty(p: string): Partial<SandboxConfig> {
  try {
    return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf-8')) : {};
  } catch {
    return {};
  }
}

function deepMerge(a: SandboxConfig, b: Partial<SandboxConfig>): SandboxConfig {
  const out: SandboxConfig = { ...a };
  if (b.enabled !== undefined) out.enabled = b.enabled;
  if (b.network) out.network = { ...a.network, ...b.network };
  if (b.filesystem) out.filesystem = { ...a.filesystem, ...b.filesystem };
  return out;
}

export function loadSandboxConfig(groupCwd: string): SandboxConfig {
  const base = readJsonOrEmpty(DEFAULT_PATH) as SandboxConfig;
  const project = readJsonOrEmpty(path.join(groupCwd, '.pi', 'sandbox.json'));
  return deepMerge(base, project);
}
