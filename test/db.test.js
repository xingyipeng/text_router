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
