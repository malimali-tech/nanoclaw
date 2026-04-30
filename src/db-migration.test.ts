import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it, vi } from 'vitest';

describe('database migrations', () => {
  it('drops legacy chats/messages tables when opening an old DB', async () => {
    const repoRoot = process.cwd();
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-db-test-'));

    try {
      process.chdir(tempDir);
      fs.mkdirSync(path.join(tempDir, 'store'), { recursive: true });

      const dbPath = path.join(tempDir, 'store', 'messages.db');
      const legacyDb = new Database(dbPath);
      legacyDb.exec(`
        CREATE TABLE chats (
          jid TEXT PRIMARY KEY,
          name TEXT,
          last_message_time TEXT
        );
        CREATE TABLE messages (
          id TEXT,
          chat_jid TEXT,
          content TEXT,
          timestamp TEXT,
          PRIMARY KEY (id, chat_jid)
        );
      `);
      legacyDb
        .prepare(
          `INSERT INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)`,
        )
        .run('tg:12345', 'Telegram DM', '2024-01-01T00:00:00.000Z');
      legacyDb.close();

      vi.resetModules();
      const { initDatabase, _closeDatabase } = await import('./db.js');
      initDatabase();

      // Verify legacy tables are gone
      const checkDb = new Database(dbPath, { readonly: true });
      const tables = checkDb
        .prepare(
          `SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`,
        )
        .all() as Array<{ name: string }>;
      const tableNames = tables.map((t) => t.name);
      checkDb.close();

      expect(tableNames).not.toContain('chats');
      expect(tableNames).not.toContain('messages');
      expect(tableNames).toContain('scheduled_tasks');
      expect(tableNames).toContain('registered_groups');

      _closeDatabase();
    } finally {
      process.chdir(repoRoot);
    }
  });
});
