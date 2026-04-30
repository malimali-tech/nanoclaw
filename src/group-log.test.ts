import { afterEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from './config.js';
import {
  _resetForTest,
  appendMessage,
  cursorPath,
  flushWrites,
  getLastBotTimestamp,
  logPath,
  metaDir,
  readCursor,
  readMessagesSince,
  writeCursor,
} from './group-log.js';
import type { NewMessage } from './types.js';

// Tests target real on-disk paths under the repo's groups/ dir, using a
// unique `__gltest-*` folder per test that is swept in afterEach. This keeps
// the module-under-test untouched (no path mocks) and exercises the same
// fs paths production uses.

function uniqueFolder(): string {
  return `__gltest-${Math.random().toString(36).slice(2, 10)}`;
}

afterEach(() => {
  if (fs.existsSync(GROUPS_DIR)) {
    for (const entry of fs.readdirSync(GROUPS_DIR)) {
      if (entry.startsWith('__gltest-')) {
        fs.rmSync(path.join(GROUPS_DIR, entry), {
          recursive: true,
          force: true,
        });
      }
    }
  }
  _resetForTest();
});

function msg(overrides: Partial<NewMessage> = {}): NewMessage {
  return {
    id: overrides.id ?? `m-${Math.random().toString(36).slice(2, 8)}`,
    chat_jid: overrides.chat_jid ?? 'oc_x',
    sender: overrides.sender ?? 'u1',
    sender_name: overrides.sender_name ?? 'User One',
    content: overrides.content ?? 'hello',
    timestamp: overrides.timestamp ?? new Date().toISOString(),
    is_from_me: overrides.is_from_me,
    is_bot_message: overrides.is_bot_message,
  };
}

describe('group-log', () => {
  describe('appendMessage + readMessagesSince', () => {
    it('appends and reads back messages in order', async () => {
      const folder = uniqueFolder();
      await appendMessage(
        folder,
        msg({ id: 'a', timestamp: '2025-01-01T00:00:00.000Z' }),
      );
      await appendMessage(
        folder,
        msg({ id: 'b', timestamp: '2025-01-01T00:00:01.000Z' }),
      );
      await appendMessage(
        folder,
        msg({ id: 'c', timestamp: '2025-01-01T00:00:02.000Z' }),
      );

      const result = readMessagesSince(folder, '', 100);
      expect(result.map((m) => m.id)).toEqual(['a', 'b', 'c']);
    });

    it('filters out bot messages and empty content', async () => {
      const folder = uniqueFolder();
      await appendMessage(
        folder,
        msg({ id: 'u1', timestamp: '2025-01-01T00:00:00.000Z' }),
      );
      await appendMessage(
        folder,
        msg({
          id: 'b1',
          timestamp: '2025-01-01T00:00:01.000Z',
          is_bot_message: true,
        }),
      );
      await appendMessage(
        folder,
        msg({
          id: 'u2',
          timestamp: '2025-01-01T00:00:02.000Z',
          content: '',
        }),
      );
      await appendMessage(
        folder,
        msg({ id: 'u3', timestamp: '2025-01-01T00:00:03.000Z' }),
      );

      const result = readMessagesSince(folder, '', 100);
      expect(result.map((m) => m.id)).toEqual(['u1', 'u3']);
    });

    it('respects sinceTimestamp (strict greater-than)', async () => {
      const folder = uniqueFolder();
      await appendMessage(
        folder,
        msg({ id: 'a', timestamp: '2025-01-01T00:00:00.000Z' }),
      );
      await appendMessage(
        folder,
        msg({ id: 'b', timestamp: '2025-01-01T00:00:01.000Z' }),
      );
      await appendMessage(
        folder,
        msg({ id: 'c', timestamp: '2025-01-01T00:00:02.000Z' }),
      );

      const result = readMessagesSince(folder, '2025-01-01T00:00:00.000Z', 100);
      expect(result.map((m) => m.id)).toEqual(['b', 'c']);
    });

    it('caps at limit, returning the most recent N', async () => {
      const folder = uniqueFolder();
      for (let i = 0; i < 5; i++) {
        await appendMessage(
          folder,
          msg({ id: `m${i}`, timestamp: `2025-01-01T00:00:0${i}.000Z` }),
        );
      }
      const result = readMessagesSince(folder, '', 3);
      expect(result.map((m) => m.id)).toEqual(['m2', 'm3', 'm4']);
    });

    it('returns empty for a folder with no log', () => {
      expect(readMessagesSince(uniqueFolder(), '', 10)).toEqual([]);
    });

    it('skips malformed jsonl lines', async () => {
      const folder = uniqueFolder();
      await appendMessage(
        folder,
        msg({ id: 'a', timestamp: '2025-01-01T00:00:00.000Z' }),
      );
      // Manually corrupt the log
      fs.appendFileSync(logPath(folder), '{not valid json\n', 'utf-8');
      await appendMessage(
        folder,
        msg({ id: 'b', timestamp: '2025-01-01T00:00:01.000Z' }),
      );

      const result = readMessagesSince(folder, '', 10);
      expect(result.map((m) => m.id)).toEqual(['a', 'b']);
    });
  });

  describe('concurrent appendMessage', () => {
    it('serialises writes from the same folder without losing entries', async () => {
      const folder = uniqueFolder();
      const N = 50;
      const writes = Array.from({ length: N }, (_, i) =>
        appendMessage(
          folder,
          msg({
            id: `m${i}`,
            timestamp: `2025-01-01T00:00:${String(i).padStart(2, '0')}.000Z`,
          }),
        ),
      );
      await Promise.all(writes);
      await flushWrites();

      const result = readMessagesSince(folder, '', 1000);
      expect(result.length).toBe(N);
      expect(new Set(result.map((m) => m.id)).size).toBe(N);
    });
  });

  describe('getLastBotTimestamp', () => {
    it('returns undefined when there are no bot messages', async () => {
      const folder = uniqueFolder();
      await appendMessage(
        folder,
        msg({ id: 'u', timestamp: '2025-01-01T00:00:00.000Z' }),
      );
      expect(getLastBotTimestamp(folder)).toBeUndefined();
    });

    it('returns the latest bot message timestamp via reverse scan', async () => {
      const folder = uniqueFolder();
      await appendMessage(
        folder,
        msg({ id: 'u1', timestamp: '2025-01-01T00:00:00.000Z' }),
      );
      await appendMessage(
        folder,
        msg({
          id: 'b1',
          timestamp: '2025-01-01T00:00:01.000Z',
          is_bot_message: true,
        }),
      );
      await appendMessage(
        folder,
        msg({ id: 'u2', timestamp: '2025-01-01T00:00:02.000Z' }),
      );
      await appendMessage(
        folder,
        msg({
          id: 'b2',
          timestamp: '2025-01-01T00:00:03.000Z',
          is_bot_message: true,
        }),
      );
      await appendMessage(
        folder,
        msg({ id: 'u3', timestamp: '2025-01-01T00:00:04.000Z' }),
      );

      expect(getLastBotTimestamp(folder)).toBe('2025-01-01T00:00:03.000Z');
    });
  });

  describe('cursor', () => {
    it('round-trips through writeCursor / readCursor', async () => {
      const folder = uniqueFolder();
      expect(readCursor(folder)).toBeUndefined();
      await writeCursor(folder, '2025-01-01T12:00:00.000Z');
      expect(readCursor(folder)).toBe('2025-01-01T12:00:00.000Z');
    });

    it('returns undefined when cursor.json is corrupted', async () => {
      const folder = uniqueFolder();
      await writeCursor(folder, '2025-01-01T00:00:00.000Z');
      fs.writeFileSync(cursorPath(folder), 'not-json', 'utf-8');
      expect(readCursor(folder)).toBeUndefined();
    });

    it('places metadata under .nanoclaw/ inside the group folder', async () => {
      const folder = uniqueFolder();
      await appendMessage(
        folder,
        msg({ id: 'a', timestamp: '2025-01-01T00:00:00.000Z' }),
      );
      await writeCursor(folder, '2025-01-01T00:00:00.000Z');
      const md = metaDir(folder);
      expect(fs.existsSync(path.join(md, 'log.jsonl'))).toBe(true);
      expect(fs.existsSync(path.join(md, 'cursor.json'))).toBe(true);
      expect(path.basename(md)).toBe('.nanoclaw');
    });
  });
});
