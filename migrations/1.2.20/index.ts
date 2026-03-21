#!/usr/bin/env tsx
/**
 * Migration 1.2.20: Update GitHub groups to use @seb-writes-code trigger
 *
 * GitHub groups previously used @${ASSISTANT_NAME} as the trigger, but on GitHub
 * that tags a real user. This migration updates all existing GitHub groups
 * (jid LIKE 'gh:%') to use @seb-writes-code instead.
 *
 * Resolves: https://github.com/cmraible/seb/issues/167
 */
import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

const projectRoot = process.argv[2];
if (!projectRoot) {
  console.error('Usage: tsx index.ts <project-root>');
  process.exit(1);
}

const dbPath = path.join(projectRoot, 'store', 'messages.db');
if (!fs.existsSync(dbPath)) {
  console.log('No database found, skipping migration');
  process.exit(0);
}

const db = new Database(dbPath);

const result = db.prepare(
  `UPDATE registered_groups
   SET trigger_pattern = '@seb-writes-code'
   WHERE jid LIKE 'gh:%' AND trigger_pattern != '@seb-writes-code'`,
).run();

console.log(`Updated ${result.changes} GitHub group(s) to use @seb-writes-code trigger`);

db.close();
