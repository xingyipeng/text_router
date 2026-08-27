import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, migrateLegacyDb } from '../src/db.js';

let dir, db;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wxr-'));
  db = openDb(join(dir, 'test.db'));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('openDb', () => {
  it('建出三张表', () => {
    const names = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    ).all().map(r => r.name);
    expect(names).toContain('users');
    expect(names).toContain('sessions');
    expect(names).toContain('verify_files');
  });

  it('重复打开不报错（幂等建表）', () => {
    const again = openDb(join(dir, 'test.db'));
    expect(again).toBeTruthy();
    again.close();
  });

  it('自动创建不存在的目录', () => {
    const nested = openDb(join(dir, 'a/b/c/nested.db'));
    expect(nested).toBeTruthy();
    nested.close();
  });

  it('条件唯一索引允许软删除后重加同名文件', () => {
    const ins = db.prepare(`
      INSERT INTO verify_files (host, filename, content, created_at, updated_at)
      VALUES (?,?,?,?,?)`);
    ins.run('a.com', 'x.txt', 'v1', 1, 1);
    db.prepare('UPDATE verify_files SET deleted_at = 2 WHERE filename = ?').run('x.txt');
    expect(() => ins.run('a.com', 'x.txt', 'v2', 3, 3)).not.toThrow();
  });

  it('条件唯一索引仍阻止两条未删除的同名记录', () => {
    const ins = db.prepare(`
      INSERT INTO verify_files (host, filename, content, created_at, updated_at)
      VALUES (?,?,?,?,?)`);
    ins.run('a.com', 'x.txt', 'v1', 1, 1);
    expect(() => ins.run('a.com', 'x.txt', 'v2', 2, 2)).toThrow(/UNIQUE/);
  });

  it('同名文件可分属不同 host', () => {
    const ins = db.prepare(`
      INSERT INTO verify_files (host, filename, content, created_at, updated_at)
      VALUES (?,?,?,?,?)`);
    ins.run('a.com', 'x.txt', 'v1', 1, 1);
    expect(() => ins.run('b.com', 'x.txt', 'v2', 2, 2)).not.toThrow();
  });

  it('旧库迁移：补 priority 列并把空 host 转为 *', () => {
    db.close(); // 先关掉 beforeEach 开的库，重建旧格式库
    const path = join(dir, 'test.db');
    rmSync(path, { force: true });
    const legacy = new Database(path);
    legacy.exec(`
      CREATE TABLE verify_files (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        host TEXT NOT NULL DEFAULT '',
        filename TEXT NOT NULL,
        content TEXT NOT NULL,
        note TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        created_by INTEGER,
        updated_at INTEGER NOT NULL,
        updated_by INTEGER,
        deleted_at INTEGER,
        deleted_by INTEGER
      );
      CREATE UNIQUE INDEX idx_active_host_filename
        ON verify_files(host, filename) WHERE deleted_at IS NULL;
      INSERT INTO verify_files (host, filename, content, note, created_at, updated_at) VALUES
        ('', 'g.txt', 'g', '', 1, 1),
        ('a.com', 'x.txt', 'v', '', 1, 1),
        ('*', 'k.txt', 'k', '', 1, 1);
    `);
    legacy.close();
    db = openDb(path); // 迁移入口

    const cols = db.prepare('PRAGMA table_info(verify_files)').all().map((c) => c.name);
    expect(cols).toContain('priority');
    const hosts = db.prepare('SELECT host, filename FROM verify_files ORDER BY filename').all();
    expect(hosts).toEqual([
      { host: '*', filename: 'g.txt' },
      { host: '*', filename: 'k.txt' },
      { host: 'a.com', filename: 'x.txt' },
    ]);
    expect(db.prepare('SELECT priority FROM verify_files').all()
      .every((r) => r.priority === 0)).toBe(true);
  });

  it('旧库迁移：空 host 与已有字面 * 同 filename 冲突时跳过转换', () => {
    db.close();
    const path = join(dir, 'test.db');
    rmSync(path, { force: true });
    const legacy = new Database(path);
    legacy.exec(`
      CREATE TABLE verify_files (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        host TEXT NOT NULL DEFAULT '',
        filename TEXT NOT NULL,
        content TEXT NOT NULL,
        note TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        created_by INTEGER,
        updated_at INTEGER NOT NULL,
        updated_by INTEGER,
        deleted_at INTEGER,
        deleted_by INTEGER
      );
      CREATE UNIQUE INDEX idx_active_host_filename
        ON verify_files(host, filename) WHERE deleted_at IS NULL;
      INSERT INTO verify_files (host, filename, content, note, created_at, updated_at) VALUES
        ('*', 'k.txt', 'star', '', 1, 1),
        ('', 'k.txt', 'empty', '', 1, 1);
    `);
    legacy.close();
    db = openDb(path);

    const rows = db.prepare('SELECT host, content FROM verify_files ORDER BY content').all();
    expect(rows).toEqual([
      { host: '', content: 'empty' }, // 撞唯一索引，保持原样（匹配层仍按全局处理）
      { host: '*', content: 'star' },
    ]);
  });
});

describe('migrateLegacyDb', () => {
  it('旧 wx_router.db 改名为 text_router.db', () => {
    writeFileSync(join(dir, 'wx_router.db'), 'legacy');
    expect(migrateLegacyDb(dir)).toBe(true);
    expect(existsSync(join(dir, 'wx_router.db'))).toBe(false);
    expect(existsSync(join(dir, 'text_router.db'))).toBe(true);
  });

  it('幂等：第二次调用不再迁移', () => {
    writeFileSync(join(dir, 'wx_router.db'), 'legacy');
    migrateLegacyDb(dir);
    expect(migrateLegacyDb(dir)).toBe(false);
  });

  it('新文件已存在时不覆盖', () => {
    writeFileSync(join(dir, 'wx_router.db'), 'legacy');
    writeFileSync(join(dir, 'text_router.db'), 'current');
    expect(migrateLegacyDb(dir)).toBe(false);
    expect(existsSync(join(dir, 'wx_router.db'))).toBe(true);
  });

  it('没有旧文件时无事发生', () => {
    expect(migrateLegacyDb(dir)).toBe(false);
  });

  it('WAL 伴生文件一起迁移', () => {
    writeFileSync(join(dir, 'wx_router.db'), 'main');
    writeFileSync(join(dir, 'wx_router.db-wal'), 'wal');
    writeFileSync(join(dir, 'wx_router.db-shm'), 'shm');
    expect(migrateLegacyDb(dir)).toBe(true);
    expect(existsSync(join(dir, 'text_router.db'))).toBe(true);
    expect(existsSync(join(dir, 'text_router.db-wal'))).toBe(true);
    expect(existsSync(join(dir, 'text_router.db-shm'))).toBe(true);
    expect(existsSync(join(dir, 'wx_router.db-wal'))).toBe(false);
    expect(existsSync(join(dir, 'wx_router.db-shm'))).toBe(false);
  });
});
