import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db.js';
import {
  createFile, updateFile, getFile, listFiles, listMeta,
  softDeleteFile, restoreFile, matchFile,
} from '../src/repo/rules.js';
import { UniqueViolation } from '../src/repo/errors.js';

let dir, db;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wxr-'));
  db = openDb(join(dir, 'test.db'));
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('createFile', () => {
  it('返回带 id 的记录', () => {
    const f = createFile(db, { host: 'a.com', filename: 'x.txt', content: 'v1', note: 'n', userId: 1 });
    expect(f.id).toBeGreaterThan(0);
    expect(f.content).toBe('v1');
    expect(f.created_by).toBe(1);
    expect(f.updated_by).toBe(1);
  });

  it('同 host 同文件名重复时抛 UniqueViolation', () => {
    createFile(db, { host: 'a.com', filename: 'x.txt', content: 'v1', note: '', userId: 1 });
    expect(() =>
      createFile(db, { host: 'a.com', filename: 'x.txt', content: 'v2', note: '', userId: 1 })
    ).toThrow(UniqueViolation);
  });
});

describe('matchFile —— 双模匹配', () => {
  it('精确 host 命中', () => {
    createFile(db, { host: 'a.com', filename: 'x.txt', content: 'exact', note: '', userId: 1 });
    expect(matchFile(db, 'a.com', 'x.txt').content).toBe('exact');
  });

  it('全局记录（host 为空）对任何 host 都命中', () => {
    createFile(db, { host: '', filename: 'g.txt', content: 'global', note: '', userId: 1 });
    expect(matchFile(db, 'anything.com', 'g.txt').content).toBe('global');
    expect(matchFile(db, '', 'g.txt').content).toBe('global');
  });

  it('精确 host 优先于全局记录', () => {
    createFile(db, { host: '', filename: 'x.txt', content: 'global', note: '', userId: 1 });
    createFile(db, { host: 'a.com', filename: 'x.txt', content: 'exact', note: '', userId: 1 });
    expect(matchFile(db, 'a.com', 'x.txt').content).toBe('exact');
    expect(matchFile(db, 'b.com', 'x.txt').content).toBe('global');
  });

  it('其他 host 的记录不会被命中', () => {
    createFile(db, { host: 'a.com', filename: 'x.txt', content: 'exact', note: '', userId: 1 });
    expect(matchFile(db, 'b.com', 'x.txt')).toBeUndefined();
  });

  it('软删除后不再命中', () => {
    const f = createFile(db, { host: 'a.com', filename: 'x.txt', content: 'v1', note: '', userId: 1 });
    softDeleteFile(db, f.id, 2);
    expect(matchFile(db, 'a.com', 'x.txt')).toBeUndefined();
  });

  it('恢复后重新命中', () => {
    const f = createFile(db, { host: 'a.com', filename: 'x.txt', content: 'v1', note: '', userId: 1 });
    softDeleteFile(db, f.id, 2);
    restoreFile(db, f.id, 3);
    expect(matchFile(db, 'a.com', 'x.txt').content).toBe('v1');
  });
});

describe('softDeleteFile', () => {
  it('记录仍在库中，带删除人', () => {
    const f = createFile(db, { host: 'a.com', filename: 'x.txt', content: 'v1', note: '', userId: 1 });
    softDeleteFile(db, f.id, 9);
    const row = getFile(db, f.id);
    expect(row.deleted_at).toBeGreaterThan(0);
    expect(row.deleted_by).toBe(9);
  });

  it('删除后可添加同名文件', () => {
    const f = createFile(db, { host: 'a.com', filename: 'x.txt', content: 'v1', note: '', userId: 1 });
    softDeleteFile(db, f.id, 2);
    expect(() =>
      createFile(db, { host: 'a.com', filename: 'x.txt', content: 'v2', note: '', userId: 1 })
    ).not.toThrow();
  });
});

describe('restoreFile', () => {
  it('同名启用记录已存在时抛 UniqueViolation', () => {
    const f = createFile(db, { host: 'a.com', filename: 'x.txt', content: 'v1', note: '', userId: 1 });
    softDeleteFile(db, f.id, 2);
    createFile(db, { host: 'a.com', filename: 'x.txt', content: 'v2', note: '', userId: 1 });
    expect(() => restoreFile(db, f.id, 3)).toThrow(UniqueViolation);
  });
});

describe('updateFile', () => {
  it('修改内容并更新 updated_by', () => {
    const f = createFile(db, { host: 'a.com', filename: 'x.txt', content: 'v1', note: '', userId: 1 });
    const updated = updateFile(db, f.id, {
      host: 'a.com', filename: 'x.txt', content: 'v2', note: '改了', userId: 7,
    });
    expect(updated.content).toBe('v2');
    expect(updated.note).toBe('改了');
    expect(updated.updated_by).toBe(7);
    expect(updated.created_by).toBe(1);
  });

  it('改成与另一条冲突的 host+filename 时抛 UniqueViolation', () => {
    createFile(db, { host: 'a.com', filename: 'x.txt', content: 'v', note: '', userId: 1 });
    const b = createFile(db, { host: 'a.com', filename: 'y.txt', content: 'v', note: '', userId: 1 });
    expect(() => updateFile(db, b.id, {
      host: 'a.com', filename: 'x.txt', content: 'v', note: '', userId: 1,
    })).toThrow(UniqueViolation);
  });

  it('修改 host 后按新域名命中，旧域名不再命中', () => {
    const f = createFile(db, { host: 'a.com', filename: 'x.txt', content: 'v1', note: '', userId: 1 });
    updateFile(db, f.id, { host: 'b.com', filename: 'x.txt', content: 'v2', note: '', userId: 1 });
    expect(matchFile(db, 'b.com', 'x.txt').content).toBe('v2');
    expect(matchFile(db, 'a.com', 'x.txt')).toBeUndefined();
  });
});

describe('listFiles', () => {
  beforeEach(() => {
    createFile(db, { host: 'a.com', filename: 'one.txt', content: 'c', note: '公众号甲', userId: 1 });
    createFile(db, { host: 'b.com', filename: 'two.txt', content: 'c', note: '小程序乙', userId: 2 });
  });

  it('默认不含已删除记录', () => {
    const all = listFiles(db, {});
    softDeleteFile(db, all[0].id, 1);
    expect(listFiles(db, {})).toHaveLength(1);
  });

  it('include_deleted 时包含已删除记录', () => {
    const all = listFiles(db, {});
    softDeleteFile(db, all[0].id, 1);
    expect(listFiles(db, { includeDeleted: true })).toHaveLength(2);
  });

  it('按 host 过滤', () => {
    expect(listFiles(db, { host: 'a.com' })).toHaveLength(1);
  });

  it('按 host 过滤时包含全局记录（空 host）', () => {
    createFile(db, { host: '', filename: 'g.txt', content: 'v', userId: 1 });
    const rows = listFiles(db, { host: 'a.com' });
    expect(rows.map((r) => r.filename).sort()).toEqual(['g.txt', 'one.txt']);
  });

  it('onlyGlobal 只返回全局记录', () => {
    createFile(db, { host: '', filename: 'g.txt', content: 'v', userId: 1 });
    expect(listFiles(db, { onlyGlobal: true }).map((r) => r.filename)).toEqual(['g.txt']);
  });

  it('按 q 搜索文件名与备注', () => {
    expect(listFiles(db, { q: 'one' })).toHaveLength(1);
    expect(listFiles(db, { q: '小程序' })).toHaveLength(1);
  });

  it('按 q 搜索内容', () => {
    createFile(db, { host: 'a.com', filename: 'key.txt', content: 'wxverify-key-123', userId: 1 });
    expect(listFiles(db, { q: 'wxverify-key' })).toHaveLength(1);
  });

  it('q 中的 LIKE 通配符按字面量匹配', () => {
    createFile(db, { host: 'a.com', filename: 'pct.txt', content: '50%', userId: 1 });
    expect(listFiles(db, { q: '%' })).toHaveLength(1);
    expect(listFiles(db, { q: '50%' })).toHaveLength(1);
  });

  it('按 sort 排序', () => {
    const byName = listFiles(db, { sort: 'filename' });
    expect(byName.map((r) => r.filename)).toEqual(['one.txt', 'two.txt']);
    const byHost = listFiles(db, { sort: 'host' });
    expect(byHost.map((r) => r.host)).toEqual(['a.com', 'b.com']);
    expect(listFiles(db, { sort: '不存在的值' }).length).toBe(2);
  });

  it('按 by 过滤：created_by 或 updated_by 任一命中', () => {
    expect(listFiles(db, { by: 2 })).toHaveLength(1);
  });

  it('带出操作人用户名', () => {
    db.prepare(`INSERT INTO users (id, username, password_hash, display_name, created_at)
                VALUES (1, 'alice', 'x', 'Alice', 1)`).run();
    const rows = listFiles(db, { host: 'a.com' });
    expect(rows[0].created_by_username).toBe('alice');
  });
});

describe('listMeta', () => {
  beforeEach(() => {
    db.prepare(`INSERT INTO users (id, username, password_hash, display_name, created_at) VALUES
      (1, 'alice', 'x', 'Alice', 1),
      (2, 'bob', 'x', 'Bob', 1)`).run();
  });

  it('hosts 只含活跃记录的非空域名，去重排序', () => {
    createFile(db, { host: 'b.com', filename: 'b.txt', content: 'v', userId: 1 });
    createFile(db, { host: 'a.com', filename: 'a.txt', content: 'v', userId: 1 });
    createFile(db, { host: 'a.com', filename: 'a2.txt', content: 'v', userId: 1 });
    createFile(db, { host: '', filename: 'g.txt', content: 'v', userId: 1 });
    expect(listMeta(db).hosts).toEqual(['a.com', 'b.com']);
  });

  it('已删除记录的唯一域名不出现在 hosts 里', () => {
    const f = createFile(db, { host: 'gone.com', filename: 'x.txt', content: 'v', userId: 1 });
    softDeleteFile(db, f.id, 1);
    expect(listMeta(db).hosts).toEqual([]);
  });

  it('persons 只含状态正常的用户（禁用的不出现）', () => {
    db.prepare('UPDATE users SET disabled_at = 1 WHERE id = 2').run(); // 禁用 bob
    expect(listMeta(db).persons.map((p) => p.username)).toEqual(['alice']);
  });

  it('从未操作过文件的正常用户也出现在 persons 里', () => {
    db.prepare(`INSERT INTO users (id, username, password_hash, display_name, created_at)
                VALUES (3, 'carol', 'x', 'Carol', 3)`).run();
    expect(listMeta(db).persons.map((p) => p.username)).toEqual(['alice', 'bob', 'carol']);
  });
});
