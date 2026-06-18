'use strict';

/**
 * Database layer — SQLite via better-sqlite3.
 * Creates the schema on first run. Stored in ./data/leave-tracker.db
 */
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(path.join(dataDir, 'leave-tracker.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id               TEXT PRIMARY KEY,
    name             TEXT NOT NULL,
    email            TEXT NOT NULL UNIQUE,
    password_hash    TEXT NOT NULL,
    total_leave_days INTEGER NOT NULL DEFAULT 25,
    color            TEXT NOT NULL,
    is_admin         INTEGER NOT NULL DEFAULT 0,
    carryover_days   INTEGER NOT NULL DEFAULT 0,
    carryover_expiry TEXT,
    allowance_year   INTEGER NOT NULL DEFAULT 0,
    created_at       INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS leaves (
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL,
    start_date TEXT NOT NULL,
    end_date   TEXT NOT NULL,
    note       TEXT,
    type       TEXT NOT NULL DEFAULT 'holiday',
    created_at INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS invites (
    token      TEXT PRIMARY KEY,
    created_by TEXT NOT NULL,
    used       INTEGER NOT NULL DEFAULT 0,
    used_by    TEXT,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_leaves_user ON leaves(user_id);
`);

// --- Lightweight migrations for databases created before newer columns ---
const leaveCols = db.prepare(`PRAGMA table_info(leaves)`).all().map(c => c.name);
if (!leaveCols.includes('type')) {
  db.exec(`ALTER TABLE leaves ADD COLUMN type TEXT NOT NULL DEFAULT 'holiday'`);
}

const userCols = db.prepare(`PRAGMA table_info(users)`).all().map(c => c.name);
if (!userCols.includes('carryover_days')) {
  db.exec(`ALTER TABLE users ADD COLUMN carryover_days INTEGER NOT NULL DEFAULT 0`);
}
if (!userCols.includes('carryover_expiry')) {
  db.exec(`ALTER TABLE users ADD COLUMN carryover_expiry TEXT`);
}
if (!userCols.includes('allowance_year')) {
  db.exec(`ALTER TABLE users ADD COLUMN allowance_year INTEGER NOT NULL DEFAULT 0`);
}
// Existing users without an allowance year start in the current year so the
// automatic rollover does not fire retroactively on first upgrade.
db.prepare(`UPDATE users SET allowance_year = ? WHERE allowance_year IS NULL OR allowance_year = 0`)
  .run(new Date().getFullYear());

module.exports = db;
