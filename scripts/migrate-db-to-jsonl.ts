#!/usr/bin/env tsx
/**
 * CLI wrapper for the legacy chats/messages → log.jsonl migration.
 * The implementation lives in src/migrations.ts.
 *
 * Usage:
 *   npx tsx scripts/migrate-db-to-jsonl.ts
 */
import { migrateDbToJsonl } from '../src/migrations.js';

migrateDbToJsonl()
  .then((report) => {
    console.log(JSON.stringify(report, null, 2));
    process.exit(0);
  })
  .catch((err) => {
    console.error('Migration failed:', err);
    process.exit(1);
  });
