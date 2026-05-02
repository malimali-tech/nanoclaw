// src/agent/global-skills.ts
//
// Single source of truth for "where does this chat look for skills".
// path-guard, container-mounts, and run.ts all key off this so the host
// fs view, the bash container view, and pi's skill discovery agree.
//
// Pi tells the LLM each skill's absolute *host* path. For the LLM to
// actually use a skill (Read its SKILL.md, run its scripts), that exact
// path must be (a) readable by the host-fs tools — see path-guard.ts —
// and (b) visible inside the bash container — see container-mounts.ts.
// Mounting at the same path on both sides keeps everything consistent
// without per-tool path translation.
//
// Scope model: skills are *chat workspace content*, not host-level
// operator config. Two layers:
//
//   • `<repo>/groups/global/skills/`   — shared across every chat. The
//                                         repo's "shipped" skills (e.g.
//                                         lark-*). Tracked in git.
//   • `<repo>/groups/<folder>/skills/` — that chat's private skills. The
//                                         agent itself can drop new
//                                         SKILL.md files here during a
//                                         conversation.
//
// We deliberately do NOT scan the host user's `~/.agents/skills/` by
// default — that directory is shared across every Claude project on the
// machine, and pulling it into NanoClaw means a feishu agent ends up with
// the user's personal `frontend-design` / `web-design-guidelines` skills
// in its system prompt. Operators who *do* want to bring outside skills
// in can opt in via `NANOCLAW_GLOBAL_SKILLS_DIRS=path1:path2`.

import fs from 'node:fs';
import path from 'node:path';
import { GROUPS_DIR } from '../config.js';
import { resolveGroupFolderPath } from '../group-folder.js';

function fromEnvOverride(): string[] | null {
  const env = process.env.NANOCLAW_GLOBAL_SKILLS_DIRS;
  if (!env) return null;
  return env
    .split(':')
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

/**
 * Return every skills directory the given chat should see, in priority
 * order (chat-private first, then shared). Filters to only paths that
 * actually exist — empty layers are skipped silently so a fresh repo
 * with no chat-private skills still works.
 *
 * Override the full list via `NANOCLAW_GLOBAL_SKILLS_DIRS=path1:path2` —
 * useful when a power user wants to point NanoClaw at their own skills
 * collection without committing it to the repo.
 */
export function chatSkillsDirs(
  groupFolder: string,
  _isMain: boolean,
): string[] {
  const env = fromEnvOverride();
  if (env) return env.filter((p) => fs.existsSync(p));

  const candidates = [
    // Chat-private — written by the chat itself or curated per-group.
    path.join(resolveGroupFolderPath(groupFolder), 'skills'),
    // Shared across every chat — the repo's shipped skills.
    path.join(GROUPS_DIR, 'global', 'skills'),
  ];
  return candidates.filter((p) => fs.existsSync(p));
}
