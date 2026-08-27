import Database from 'better-sqlite3';
import { existsSync, mkdirSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const DB_FILENAME = 'text_router.db';

// 一次性迁移：旧版库文件 wx_router.db 存在且新文件名不存在时改名为 text_router.db。
// -wal/-shm 伴生文件必须一起搬：WAL 里可能还有未 checkpoint 的数据，只搬主文件会丢最近的写入。
// 服务端与 CLI 脚本共用，无论谁先启动都只迁移一次，老部署数据不丢。
export function migrateLegacyDb(dataDir) {
  const legacy = join(dataDir, 'wx_router.db');
  const current = join(dataDir, DB_FILENAME);
  if (!existsSync(legacy) || existsSync(current)) return false;
  renameSync(legacy, current);
  for (const ext of ['-wal', '-shm']) {
    if (existsSync(legacy + ext)) renameSync(legacy + ext, current + ext);
  }
  return true;
}

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
  priority   INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  created_by INTEGER,
  updated_at INTEGER NOT NULL,
  updated_by INTEGER,
  deleted_at INTEGER,
  deleted_by INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_active_host_filename
  ON verify_files(host, filename) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

// 幂等迁移：旧库补 priority 列 + 存量全局记录 '' → '*'。
// UPDATE OR IGNORE 兜底：旧库若已有同 filename 的字面 '*' 活跃行，
// '' → '*' 会撞唯一索引，此时跳过该行（匹配层仍把 '' 当全局处理，行为不变）。
function migrateSchema(db) {
  const cols = db.prepare('PRAGMA table_info(verify_files)').all().map((c) => c.name);
  if (!cols.includes('priority')) {
    db.exec('ALTER TABLE verify_files ADD COLUMN priority INTEGER NOT NULL DEFAULT 0');
  }
  db.prepare("UPDATE OR IGNORE verify_files SET host = '*' WHERE host = ''").run();
}

export function openDb(dbPath) {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  migrateSchema(db);
  return db;
}
