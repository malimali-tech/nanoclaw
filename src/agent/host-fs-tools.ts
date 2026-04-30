// src/agent/host-fs-tools.ts
//
// Host-side fs Operations for pi's Read/Write/Edit/Grep/Find/Ls tools.
// Wraps Node fs primitives with a per-chat path guard so the agent can't
// reach files outside its workspace, even though these calls execute in
// the NanoClaw process (not in the bash container).
//
// Why these stay on host instead of being forwarded into the container:
// pi's Read supports binary files / NUL bytes / image MIME detection /
// auto-resizing. Tunneling that through `docker exec` corrupts binaries
// and was the proximate cause of the prior tool-sandbox PR being reverted.
// Path-guarding host fs preserves correctness; the bind mount means the
// files we touch are exactly the files the bash container sees.

import {
  access as fsAccess,
  constants,
  existsSync,
  promises as fsp,
  readFileSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { extname } from 'node:path';
import path from 'node:path';
import type {
  EditOperations,
  FindOperations,
  GrepOperations,
  LsOperations,
  ReadOperations,
  WriteOperations,
} from '@mariozechner/pi-coding-agent';
import type { PathGuard } from './path-guard.js';

const IMAGE_MIMES: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

export function makeReadOps(guard: PathGuard): ReadOperations {
  return {
    async readFile(p) {
      guard.assertReadable(p);
      return fsp.readFile(p);
    },
    async access(p) {
      guard.assertReadable(p);
      await new Promise<void>((resolve, reject) =>
        fsAccess(p, constants.R_OK, (err) =>
          err ? reject(err) : resolve(),
        ),
      );
    },
    async detectImageMimeType(p) {
      guard.assertReadable(p);
      return IMAGE_MIMES[extname(p).toLowerCase()] ?? null;
    },
  };
}

export function makeWriteOps(guard: PathGuard): WriteOperations {
  return {
    async writeFile(p, content) {
      guard.assertWritable(p);
      await fsp.writeFile(p, content, 'utf-8');
    },
    async mkdir(dir) {
      guard.assertWritable(dir);
      await fsp.mkdir(dir, { recursive: true });
    },
  };
}

export function makeEditOps(guard: PathGuard): EditOperations {
  return {
    async readFile(p) {
      guard.assertReadable(p);
      return fsp.readFile(p);
    },
    async writeFile(p, content) {
      // Edits target an existing file: must be writable.
      guard.assertWritable(p);
      await fsp.writeFile(p, content, 'utf-8');
    },
    async access(p) {
      // Pi's Edit checks both R_OK and W_OK before applying. Match that.
      guard.assertWritable(p);
      await new Promise<void>((resolve, reject) =>
        fsAccess(p, constants.R_OK | constants.W_OK, (err) =>
          err ? reject(err) : resolve(),
        ),
      );
    },
  };
}

export function makeGrepOps(guard: PathGuard): GrepOperations {
  return {
    isDirectory(p) {
      guard.assertReadable(p);
      return statSync(p).isDirectory();
    },
    readFile(p) {
      guard.assertReadable(p);
      return readFileSync(p, 'utf-8');
    },
  };
}

export function makeFindOps(guard: PathGuard, defaultCwd: string): FindOperations {
  return {
    exists(p) {
      try {
        guard.assertReadable(p);
      } catch {
        return false;
      }
      return existsSync(p);
    },
    glob(pattern, cwd, options) {
      // Anchor the search at the supplied cwd (validated below). Pi calls
      // this with a chat-local cwd by default; if the agent supplies an
      // out-of-workspace path we refuse rather than walking it.
      const anchor = cwd ?? defaultCwd;
      guard.assertReadable(anchor);

      const results: string[] = [];
      const limit = options.limit ?? 1000;
      const ignoreSet = new Set(options.ignore ?? []);
      const matcher = compileGlob(pattern);

      const walk = (dir: string): void => {
        if (results.length >= limit) return;
        let entries: import('node:fs').Dirent[];
        try {
          entries = readdirSync(dir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const entry of entries) {
          if (results.length >= limit) return;
          const full = path.join(dir, entry.name);
          const rel = path.relative(anchor, full);
          if (ignoreSet.has(entry.name)) continue;
          if (entry.isDirectory()) {
            walk(full);
          } else if (matcher(rel) || matcher(entry.name)) {
            results.push(full);
          }
        }
      };
      walk(anchor);
      return results;
    },
  };
}

export function makeLsOps(guard: PathGuard): LsOperations {
  return {
    exists(p) {
      try {
        guard.assertReadable(p);
      } catch {
        return false;
      }
      return existsSync(p);
    },
    stat(p) {
      guard.assertReadable(p);
      return statSync(p);
    },
    readdir(p) {
      guard.assertReadable(p);
      return readdirSync(p);
    },
  };
}

/**
 * Minimal glob → RegExp matcher for the Find tool's common patterns:
 * `*.ts`, `**\/*.md`, `src/**\/*.ts`. Sufficient for chat-driven
 * exploration; falls short of full globstar-with-brace-expansion. If
 * an agent needs exotic patterns it can drop to bash + find / fd in the
 * container.
 */
function compileGlob(pattern: string): (s: string) => boolean {
  const re = new RegExp(
    '^' +
      pattern
        .split(/(\*\*\/?|\*|\?|\[[^\]]+\])/)
        .map((part) => {
          if (part === '**/' || part === '**') return '(.*?/?)';
          if (part === '*') return '[^/]*';
          if (part === '?') return '[^/]';
          if (part.startsWith('[') && part.endsWith(']')) return part;
          return part.replace(/[.+^${}()|\\]/g, '\\$&');
        })
        .join('') +
      '$',
  );
  return (s) => re.test(s);
}
