import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db.js';
import {
  insertRequest, listRequests,
  trimRequests, clearRequests, countRequests,
} from '../src/repo/requests.js';

let dir, db;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wxr-'));
  db = openDb(join(dir, 'test.db')); // SCHEMA 自动建 requests 表
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const entry = (path, extra = {}) => ({
  at: Date.now(), host: 'a.com', forwardedHost: 'a.com', resolvedHost: 'a.com',
  path, filename: path.slice(1), scheme: 'https', method: 'GET',
  ua: 'Mozilla/5.0', ip: '1.2.3.4', remoteIp: '203.0.113.9', hit: false, fileId: null, ...extra,
});

describe('requests 持久化表', () => {
  it('插入后字段完整映射', () => {
    insertRequest(db, entry('/x.txt', { hit: true, fileId: 7, method: 'POST' }));
    const { rows } = listRequests(db);
    expect(rows).toHaveLength(1);
    const r = rows[0];
    expect(r.path).toBe('/x.txt');
    expect(r.hit).toBe(true);
    expect(r.fileId).toBe(7);
    expect(r.method).toBe('POST');
    expect(r.ua).toBe('Mozilla/5.0');
    expect(r.ip).toBe('1.2.3.4');
    expect(r.remoteIp).toBe('203.0.113.9');
    expect(r.scheme).toBe('https');
    expect(typeof r.id).toBe('number');
  });

  it('分页：最新在前，beforeId 取更早一页，hasMore 正确', () => {
    for (let i = 1; i <= 5; i++) insertRequest(db, entry(`/${i}.txt`));

    const p1 = listRequests(db, { limit: 2 });
    expect(p1.rows.map((r) => r.path)).toEqual(['/5.txt', '/4.txt']);
    expect(p1.total).toBe(5);
    expect(p1.hasMore).toBe(true);

    const oldest = p1.rows[p1.rows.length - 1].id;
    const p2 = listRequests(db, { beforeId: oldest, limit: 2 });
    expect(p2.rows.map((r) => r.path)).toEqual(['/3.txt', '/2.txt']);
    expect(p2.hasMore).toBe(true);

    const p3 = listRequests(db, { beforeId: p2.rows[1].id, limit: 2 });
    expect(p3.rows.map((r) => r.path)).toEqual(['/1.txt']);
    expect(p3.hasMore).toBe(false);
  });

  it('limit 缺省 200，传入值限制在 1-500', () => {
    for (let i = 1; i <= 3; i++) insertRequest(db, entry(`/${i}.txt`));
    expect(listRequests(db).rows).toHaveLength(3); // 缺省 200，全量返回
    expect(listRequests(db, { limit: 0 }).rows).toHaveLength(3); // 0 视为缺省
    expect(listRequests(db, { limit: 9999 }).rows).toHaveLength(3); // 上限 500 内全量
    expect(listRequests(db, { limit: 1 }).rows).toHaveLength(1);
  });

  it('trimRequests 超出容量删最旧', () => {
    for (let i = 1; i <= 5; i++) insertRequest(db, entry(`/${i}.txt`));
    trimRequests(db, 3);
    const { rows } = listRequests(db);
    expect(rows.map((r) => r.path)).toEqual(['/5.txt', '/4.txt', '/3.txt']);
    expect(countRequests(db)).toBe(3);
  });

  it('clearRequests 清空', () => {
    insertRequest(db, entry('/x.txt'));
    clearRequests(db);
    expect(countRequests(db)).toBe(0);
    expect(listRequests(db).rows).toHaveLength(0);
  });
});
