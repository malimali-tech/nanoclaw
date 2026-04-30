import * as fsp from 'fs/promises';
import { existsSync, readFileSync, mkdirSync } from 'fs';
import path from 'path';

import { GROUPS_DIR } from './config.js';
import { logger } from './logger.js';
import type { NewMessage } from './types.js';

/**
 * Per-group append-only message log + cursor, replacing the old `messages`
 * and `chats` SQLite tables. Lives under `groups/<folder>/.nanoclaw/` to
 * keep the agent's working directory clean.
 *
 * Access patterns:
 *   - append (one writer per group, but multiple paths: channel inbound,
 *     scheduler, agent reply) → serialised via per-folder Promise chain
 *   - read tail since cursor → small (<= MAX_MESSAGES_PER_PROMPT) → read
 *     whole file is fine for personal-assistant scale
 *   - find last bot reply (cursor recovery) → reverse scan
 */

const META_DIR_NAME = '.nanoclaw';
const LOG_FILE = 'log.jsonl';
const CURSOR_FILE = 'cursor.json';

interface CursorState {
  lastAgentTimestamp?: string;
}

// Per-folder Promise chain to serialise appendFile calls. `.catch` keeps the
// chain alive after a failure so one bad write does not freeze the group.
const writeChain: Map<string, Promise<unknown>> = new Map();

export function metaDir(folder: string): string {
  return path.join(GROUPS_DIR, folder, META_DIR_NAME);
}

export function logPath(folder: string): string {
  return path.join(metaDir(folder), LOG_FILE);
}

export function cursorPath(folder: string): string {
  return path.join(metaDir(folder), CURSOR_FILE);
}

function ensureMetaDir(folder: string): void {
  mkdirSync(metaDir(folder), { recursive: true });
}

/** Append one message line. Resolves once the bytes are flushed. */
export function appendMessage(folder: string, msg: NewMessage): Promise<void> {
  const prev = writeChain.get(folder) ?? Promise.resolve();
  const next = prev.then(async () => {
    ensureMetaDir(folder);
    await fsp.appendFile(
      logPath(folder),
      `${JSON.stringify(msg)}\n`,
      'utf-8',
    );
  });
  writeChain.set(
    folder,
    next.catch((err) => {
      logger.error({ folder, err }, 'group-log: appendMessage failed');
    }),
  );
  return next;
}

function readAllLines(folder: string): NewMessage[] {
  const p = logPath(folder);
  if (!existsSync(p)) return [];
  let text: string;
  try {
    text = readFileSync(p, 'utf-8');
  } catch (err) {
    logger.warn({ folder, err }, 'group-log: read failed');
    return [];
  }
  if (!text) return [];
  const out: NewMessage[] = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t) as NewMessage);
    } catch {
      logger.warn({ folder }, 'group-log: skipping malformed jsonl line');
    }
  }
  return out;
}

/**
 * Read non-bot, non-empty messages strictly after `sinceTimestamp`,
 * chronologically ordered, capped at the most recent `limit` entries.
 * Matches the old `getMessagesSince` semantics: bot self-replies are
 * excluded so they never re-enter the prompt as user input.
 */
export function readMessagesSince(
  folder: string,
  sinceTimestamp: string,
  limit: number,
): NewMessage[] {
  const all = readAllLines(folder);
  const filtered = all.filter(
    (m) =>
      m.timestamp > sinceTimestamp &&
      !m.is_bot_message &&
      m.content !== '' &&
      m.content !== null &&
      m.content !== undefined,
  );
  if (filtered.length <= limit) return filtered;
  return filtered.slice(filtered.length - limit);
}

/**
 * Most recent bot-authored message timestamp, used to recover the
 * processing cursor when `cursor.json` is missing (new install,
 * corrupted state). Reverse scan to keep this O(tail) in practice.
 */
export function getLastBotTimestamp(folder: string): string | undefined {
  const all = readAllLines(folder);
  for (let i = all.length - 1; i >= 0; i--) {
    if (all[i].is_bot_message) return all[i].timestamp;
  }
  return undefined;
}

export function readCursor(folder: string): string | undefined {
  const p = cursorPath(folder);
  if (!existsSync(p)) return undefined;
  try {
    const data = JSON.parse(readFileSync(p, 'utf-8')) as CursorState;
    return data.lastAgentTimestamp;
  } catch (err) {
    logger.warn(
      { folder, err },
      'group-log: cursor parse failed, treating as missing',
    );
    return undefined;
  }
}

export async function writeCursor(
  folder: string,
  timestamp: string,
): Promise<void> {
  ensureMetaDir(folder);
  await fsp.writeFile(
    cursorPath(folder),
    JSON.stringify({ lastAgentTimestamp: timestamp } satisfies CursorState),
    'utf-8',
  );
}

/** Wait for any pending appends. Use in shutdown / before snapshot reads. */
export async function flushWrites(): Promise<void> {
  await Promise.all([...writeChain.values()]);
}

/** @internal — for tests */
export function _resetForTest(): void {
  writeChain.clear();
}
