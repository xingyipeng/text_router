import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT    NOT NULL,
  password_hash TEXT    NOT NULL,
  display_name  TEXT    NOT NULL DEFAULT '',
  is_super      INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  created_by    INTEGER,
  disabled_at   INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_active
  ON users(username) WHERE disabled_at IS NULL;

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT    PRIMARY KEY,
  user_id    INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS verify_files (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  host       TEXT    NOT NULL DEFAULT '',
  filename   TEXT    NOT NULL,
  content    TEXT    NOT NULL,
  note       TEXT    NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  created_by INTEGER,
  updated_at INTEGER NOT NULL,
  updated_by INTEGER,
  deleted_at INTEGER,
  deleted_by INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_active_host_filename
  ON verify_files(host, filename) WHERE deleted_at IS NULL;
`;

export function openDb(dbPath) {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  return db;
}
