import * as fsp from 'fs/promises';
import { readFileSync, mkdirSync, statSync } from 'fs';
import path from 'path';

import { GROUPS_DIR } from './config.js';
import { logger } from './logger.js';
import type { NewMessage } from './types.js';
import { KeyedSerialChain } from './util/serial-chain.js';

/**
 * Per-group append-only message log, replacing the old `messages` and
 * `chats` SQLite tables. Lives under `groups/<folder>/.nanoclaw/` to keep
 * the agent's working directory clean.
 *
 * Cursor: there is no separate cursor file. The processing cursor is the
 * timestamp of the last bot-authored line in `log.jsonl`. `index.ts`
 * keeps an in-memory cache; on cold start `getLastBotTimestamp` rederives
 * it via a reverse scan. log.jsonl is therefore the single source of
 * truth for "what has the agent already replied to".
 *
 * Access patterns:
 *   - append (one writer per group, but multiple paths: channel inbound,
 *     scheduler, agent reply) → serialised via per-folder Promise chain
 *   - read tail since cursor → small (<= MAX_MESSAGES_PER_PROMPT) → read
 *     whole file is fine for personal-assistant scale
 *   - cursor recovery → reverse scan for last bot row
 */

const META_DIR_NAME = '.nanoclaw';
const LOG_FILE = 'log.jsonl';

// Per-folder FIFO chain serializing appendFile calls. SerialChain isolates
// failures so one bad write does not freeze subsequent appends for the group.
const appendChain = new KeyedSerialChain<string>();

export function metaDir(folder: string): string {
  return path.join(GROUPS_DIR, folder, META_DIR_NAME);
}

export function logPath(folder: string): string {
  return path.join(metaDir(folder), LOG_FILE);
}

function ensureMetaDir(folder: string): void {
  mkdirSync(metaDir(folder), { recursive: true });
}

/** Append one message line. Resolves once the bytes are flushed. */
export function appendMessage(folder: string, msg: NewMessage): Promise<void> {
  const next = appendChain.run(folder, async () => {
    ensureMetaDir(folder);
    await fsp.appendFile(logPath(folder), `${JSON.stringify(msg)}\n`, 'utf-8');
  });
  next.catch((err) => {
    logger.error({ folder, err }, 'group-log: appendMessage failed');
  });
  return next;
}

// Cache parsed log.jsonl per folder, invalidated by (size, mtimeMs). The
// hot path is the message-loop polling every group every 2s; without this
// each tick re-reads + re-parses every group's full log.
const lineCache = new Map<
  string,
  { size: number; mtimeMs: number; lines: NewMessage[] }
>();

function readAllLines(folder: string): NewMessage[] {
  const p = logPath(folder);
  let stat: { size: number; mtimeMs: number };
  try {
    const s = statSync(p);
    stat = { size: s.size, mtimeMs: s.mtimeMs };
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    logger.warn({ folder, err }, 'group-log: stat failed');
    return [];
  }
  const cached = lineCache.get(folder);
  if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
    return cached.lines;
  }
  let text: string;
  try {
    text = readFileSync(p, 'utf-8');
  } catch (err) {
    logger.warn({ folder, err }, 'group-log: read failed');
    return [];
  }
  if (!text) {
    lineCache.set(folder, { ...stat, lines: [] });
    return [];
  }
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
  lineCache.set(folder, { ...stat, lines: out });
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
 * Most recent bot-authored message timestamp. This IS the processing
 * cursor — `index.ts` caches it in memory but rederives it from here on
 * cold start. Reverse scan to keep this O(tail) in practice.
 */
export function getLastBotTimestamp(folder: string): string | undefined {
  const all = readAllLines(folder);
  for (let i = all.length - 1; i >= 0; i--) {
    if (all[i].is_bot_message) return all[i].timestamp;
  }
  return undefined;
}

/** Wait for any pending appends. Use in shutdown / before snapshot reads. */
export async function flushWrites(): Promise<void> {
  await appendChain.drainAll();
}

/** @internal — for tests */
export function _resetForTest(): void {
  appendChain.clear();
  lineCache.clear();
}
