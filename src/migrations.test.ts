import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { GROUPS_DIR } from './config.js';
import { _resetForTest, logPath, cursorPath } from './group-log.js';
import { migrateDbToJsonl } from './migrations.js';

afterEach(() => {
  if (fs.existsSync(GROUPS_DIR)) {
    for (const entry of fs.readdirSync(GROUPS_DIR)) {
      if (entry.startsWith('__test-mig-')) {
        fs.rmSync(path.join(GROUPS_DIR, entry), {
          recursive: true,
          force: true,
        });
      }
    }
  }
  _resetForTest();
});

function seedLegacyDb(dbPath: string, folder: string): void {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE chats (jid TEXT PRIMARY KEY);
    CREATE TABLE messages (
      id TEXT, chat_jid TEXT, sender TEXT, sender_name TEXT,
      content TEXT, timestamp TEXT,
      is_from_me INTEGER, is_bot_message INTEGER,
      reply_to_message_id TEXT, reply_to_message_content TEXT, reply_to_sender_name TEXT,
      PRIMARY KEY (id, chat_jid)
    );
    CREATE TABLE registered_groups (jid TEXT PRIMARY KEY, folder TEXT);
    CREATE TABLE router_state (key TEXT PRIMARY KEY, value TEXT);
  `);
  db.prepare(`INSERT INTO registered_groups (jid, folder) VALUES (?, ?)`).run(
    'feishu:oc_x',
    folder,
  );
  const insert = db.prepare(
    `INSERT INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  insert.run('m1', 'feishu:oc_x', 'u1', 'Alice', 'hi', '2025-01-01T00:00:00.000Z', 0, 0);
  insert.run('m2', 'feishu:oc_x', 'bot', 'Andy', 'hello', '2025-01-01T00:00:01.000Z', 1, 1);
  insert.run('m3', 'feishu:oc_x', 'u1', 'Alice', 'thanks', '2025-01-01T00:00:02.000Z', 0, 0);
  // Cursor in router_state
  db.prepare(`INSERT INTO router_state (key, value) VALUES (?, ?)`).run(
    'last_agent_timestamp',
    JSON.stringify({ 'feishu:oc_x': '2025-01-01T00:00:01.000Z' }),
  );
  db.close();
}

describe('migrateDbToJsonl', () => {
  it('returns no-op when DB does not exist', async () => {
    const tmp = fs.mkdtempSync(path.join(path.resolve('store'), 'mig-no-db-'));
    try {
      const report = await migrateDbToJsonl({
        dbPath: path.join(tmp, 'nope.db'),
      });
      expect(report.migrated).toBe(false);
      expect(report.reason).toBe('no-db');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('migrates messages and cursor for a registered group', async () => {
    const folder = `__test-mig-${Math.random().toString(36).slice(2, 8)}`;
    const tmp = fs.mkdtempSync(path.join(path.resolve('store'), 'mig-ok-'));
    try {
      const dbPath = path.join(tmp, 'messages.db');
      seedLegacyDb(dbPath, folder);

      const report = await migrateDbToJsonl({ dbPath });

      expect(report.migrated).toBe(true);
      expect(report.groupsTouched).toBe(1);
      expect(report.rowsWritten).toBe(3);
      expect(report.cursorsWritten).toBe(1);

      const lines = fs
        .readFileSync(logPath(folder), 'utf-8')
        .trim()
        .split('\n');
      expect(lines).toHaveLength(3);
      const ids = lines.map((l) => JSON.parse(l).id);
      expect(ids).toEqual(['m1', 'm2', 'm3']);

      const cursor = JSON.parse(fs.readFileSync(cursorPath(folder), 'utf-8'));
      expect(cursor.lastAgentTimestamp).toBe('2025-01-01T00:00:01.000Z');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('skips messages from groups missing in registered_groups', async () => {
    const folder = `__test-mig-${Math.random().toString(36).slice(2, 8)}`;
    const tmp = fs.mkdtempSync(path.join(path.resolve('store'), 'mig-skip-'));
    try {
      const dbPath = path.join(tmp, 'messages.db');
      seedLegacyDb(dbPath, folder);
      // Add an extra message tied to an unregistered jid
      const db = new Database(dbPath);
      db.prepare(
        `INSERT INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        'orphan',
        'feishu:oc_unknown',
        'u',
        'X',
        'orphan',
        '2025-01-01T00:00:03.000Z',
        0,
        0,
      );
      db.close();

      const report = await migrateDbToJsonl({ dbPath });
      expect(report.rowsWritten).toBe(3); // orphan skipped
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('is a no-op when messages table no longer exists', async () => {
    const tmp = fs.mkdtempSync(path.join(path.resolve('store'), 'mig-2nd-'));
    try {
      const dbPath = path.join(tmp, 'messages.db');
      const db = new Database(dbPath);
      db.exec(`CREATE TABLE registered_groups (jid TEXT PRIMARY KEY, folder TEXT);`);
      db.close();

      const report = await migrateDbToJsonl({ dbPath });
      expect(report.migrated).toBe(false);
      expect(report.reason).toBe('no-messages-table');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
