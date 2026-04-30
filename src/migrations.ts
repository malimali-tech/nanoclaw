/**
 * One-shot migration: read legacy `messages` and `chats` tables from
 * store/messages.db and write per-group `groups/<folder>/.nanoclaw/log.jsonl`
 * + `cursor.json`. Idempotent — re-running on a migrated DB (where the
 * legacy tables have been dropped) is a no-op.
 *
 * Triggered automatically from `main()` before `initDatabase` so the legacy
 * tables can be cleanly dropped afterwards. Also exposed as a CLI via
 * `scripts/migrate-db-to-jsonl.ts`.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

import { GROUPS_DIR, STORE_DIR } from './config.js';
import { appendMessage, flushWrites, writeCursor } from './group-log.js';
import { logger } from './logger.js';
import type { NewMessage } from './types.js';

interface MessageRow {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me: number;
  is_bot_message: number;
  reply_to_message_id: string | null;
  reply_to_message_content: string | null;
  reply_to_sender_name: string | null;
}

interface RegisteredRow {
  jid: string;
  folder: string;
}

function tableExists(db: Database.Database, name: string): boolean {
  const row = db
    .prepare(
      `SELECT 1 AS x FROM sqlite_master WHERE type='table' AND name=?`,
    )
    .get(name) as { x: number } | undefined;
  return !!row;
}

export interface MigrationReport {
  migrated: boolean;
  reason?: string;
  groupsTouched: number;
  rowsWritten: number;
  cursorsWritten: number;
}

export async function migrateDbToJsonl(opts?: {
  dbPath?: string;
  dryRun?: boolean;
}): Promise<MigrationReport> {
  const dbPath = opts?.dbPath ?? path.join(STORE_DIR, 'messages.db');
  if (!fs.existsSync(dbPath)) {
    return {
      migrated: false,
      reason: 'no-db',
      groupsTouched: 0,
      rowsWritten: 0,
      cursorsWritten: 0,
    };
  }
  const db = new Database(dbPath, { readonly: true });

  if (!tableExists(db, 'messages')) {
    db.close();
    return {
      migrated: false,
      reason: 'no-messages-table',
      groupsTouched: 0,
      rowsWritten: 0,
      cursorsWritten: 0,
    };
  }

  // Build jid -> folder map from registered_groups
  const folderByJid = new Map<string, string>();
  if (tableExists(db, 'registered_groups')) {
    for (const row of db
      .prepare(`SELECT jid, folder FROM registered_groups`)
      .all() as RegisteredRow[]) {
      folderByJid.set(row.jid, row.folder);
    }
  }

  // Load last_agent_timestamp map (if any) for cursor seeding
  const cursorByJid = new Map<string, string>();
  if (tableExists(db, 'router_state')) {
    const row = db
      .prepare(`SELECT value FROM router_state WHERE key = ?`)
      .get('last_agent_timestamp') as { value: string } | undefined;
    if (row?.value) {
      try {
        const parsed = JSON.parse(row.value) as Record<string, string>;
        for (const [jid, ts] of Object.entries(parsed)) {
          cursorByJid.set(jid, ts);
        }
      } catch {
        /* ignore corrupt cursor map */
      }
    }
  }

  // Pull all messages, sorted ascending. Personal-assistant scale; safe.
  const rows = db
    .prepare(
      `SELECT id, chat_jid, sender, sender_name, content, timestamp,
              is_from_me, is_bot_message,
              reply_to_message_id, reply_to_message_content, reply_to_sender_name
       FROM messages ORDER BY timestamp ASC`,
    )
    .all() as MessageRow[];

  db.close();

  const skipped: Record<string, number> = {};
  const written: Record<string, number> = {};
  for (const row of rows) {
    const folder = folderByJid.get(row.chat_jid);
    if (!folder) {
      skipped[row.chat_jid] = (skipped[row.chat_jid] ?? 0) + 1;
      continue;
    }
    const msg: NewMessage = {
      id: row.id,
      chat_jid: row.chat_jid,
      sender: row.sender,
      sender_name: row.sender_name,
      content: row.content,
      timestamp: row.timestamp,
      is_from_me: row.is_from_me === 1,
      is_bot_message: row.is_bot_message === 1,
    };
    if (row.reply_to_message_id)
      msg.reply_to_message_id = row.reply_to_message_id;
    if (row.reply_to_message_content)
      msg.reply_to_message_content = row.reply_to_message_content;
    if (row.reply_to_sender_name)
      msg.reply_to_sender_name = row.reply_to_sender_name;

    if (!opts?.dryRun) {
      await appendMessage(folder, msg);
    }
    written[folder] = (written[folder] ?? 0) + 1;
  }
  if (!opts?.dryRun) {
    await flushWrites();
  }

  let cursorsWritten = 0;
  for (const [jid, ts] of cursorByJid.entries()) {
    const folder = folderByJid.get(jid);
    if (!folder) continue;
    if (!opts?.dryRun) {
      await writeCursor(folder, ts);
    }
    cursorsWritten++;
  }

  if (!opts?.dryRun) {
    logger.info(
      {
        groupsTouched: Object.keys(written).length,
        rowsWritten:
          rows.length -
          Object.values(skipped).reduce((a, b) => a + b, 0),
      },
      'migrate-db-to-jsonl: complete (legacy chats/messages tables will be dropped by initDatabase)',
    );
  }

  if (Object.keys(skipped).length > 0) {
    logger.warn(
      { skipped },
      'migrate-db-to-jsonl: skipped messages from unregistered groups',
    );
  }

  // Confirm groups dir exists for any touched folder
  for (const folder of Object.keys(written)) {
    fs.mkdirSync(path.join(GROUPS_DIR, folder), { recursive: true });
  }

  return {
    migrated: true,
    groupsTouched: Object.keys(written).length,
    rowsWritten: Object.values(written).reduce((a, b) => a + b, 0),
    cursorsWritten,
  };
}

