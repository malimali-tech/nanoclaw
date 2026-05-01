// src/agent/global-skills.ts
//
// Single source of truth for "where do globally-shared skills live".
// path-guard, container-mounts, and run.ts all key off this so the host
// fs view, the bash container view, and pi's skill discovery agree.
//
// Pi tells the LLM each skill's absolute *host* path. For the LLM to
// actually use a skill (Read its SKILL.md, run its scripts), that exact
// path must be (a) readable by the host-fs tools — see path-guard.ts —
// and (b) visible inside the bash container — see container-mounts.ts.
// Mounting at the same path on both sides keeps everything consistent
// without per-tool path translation.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_DIRS = [
  // Where `npx skills add ...` installs by default — primary location.
  path.join(os.homedir(), '.agents', 'skills'),
  // Pi-mono's own user-level skill dir (already discovered by pi without
  // help; we still add it to allowedRoots so Read can fetch SKILL.md).
  path.join(os.homedir(), '.pi', 'agent', 'skills'),
];

function fromEnvOverride(): string[] | null {
  const env = process.env.NANOCLAW_GLOBAL_SKILLS_DIRS;
  if (!env) return null;
  return env
    .split(':')
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

/**
 * Return every globally-shared skills directory that exists on disk.
 * Defaults: `~/.agents/skills` and `~/.pi/agent/skills`.
 * Override the full list via `NANOCLAW_GLOBAL_SKILLS_DIRS=path1:path2`.
 */
export function globalSkillsDirs(): string[] {
  const candidates = fromEnvOverride() ?? DEFAULT_DIRS;
  return candidates.filter((p) => fs.existsSync(p));
}
