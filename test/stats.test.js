import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db.js';
import { createFile } from '../src/repo/rules.js';
import { createUser } from '../src/repo/users.js';
import { createRequestLog } from '../src/requestlog.js';
import { computeStats } from '../src/stats.js';
import { createApp } from '../src/app.js';

let dir, db;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wxr-'));
  db = openDb(join(dir, 'test.db'));
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('computeStats', () => {
  it('统计文件总数、绑定/全局数与域名分布', () => {
    createFile(db, { host: 'a.com', filename: 'x.txt', content: 'v', userId: 1 });
    createFile(db, { host: 'a.com', filename: 'y.txt', content: 'v', userId: 1 });
    createFile(db, { host: '*', filename: 'g.txt', content: 'v', userId: 1 });
    const s = computeStats(db, createRequestLog());
    expect(s.files.total).toBe(3);
    expect(s.files.bound).toBe(2);
    expect(s.files.global).toBe(1);
    expect(s.files.domains).toBe(1);
    expect(s.files.byDomain).toEqual([{ host: 'a.com', count: 2 }]);
  });

  it('模式记录计入绑定数但不出现在域名分布里', () => {
    createFile(db, { host: '*.a.com', filename: 'p.txt', content: 'v', userId: 1 });
    createFile(db, { host: '*', filename: 'g.txt', content: 'v', userId: 1 });
    createFile(db, { host: 'a.com', filename: 'x.txt', content: 'v', userId: 1 });
    const s = computeStats(db, createRequestLog());
    expect(s.files.total).toBe(3);
    expect(s.files.global).toBe(1);
    expect(s.files.bound).toBe(2);
    expect(s.files.byDomain).toEqual([{ host: 'a.com', count: 1 }]);
  });

  it('域名分布按数量降序', () => {
    createFile(db, { host: 'a.com', filename: 'x.txt', content: 'v', userId: 1 });
    createFile(db, { host: 'b.com', filename: 'y.txt', content: 'v', userId: 1 });
    createFile(db, { host: 'b.com', filename: 'z.txt', content: 'v', userId: 1 });
    const s = computeStats(db, createRequestLog());
    expect(s.files.byDomain.map((d) => d.host)).toEqual(['b.com', 'a.com']);
  });

  it('请求统计区分命中与未命中', () => {
    const log = createRequestLog();
    log.record({ path: '/x.txt', hit: true });
    log.record({ path: '/m.txt', hit: false });
    const s = computeStats(db, log);
    expect(s.requests.total).toBe(2);
    expect(s.requests.hits).toBe(1);
    expect(s.requests.today).toBe(2);
    expect(s.requests.todayHits).toBe(1);
    expect(s.requests.todayMisses).toBe(1);
  });

  it('按小时聚合最近 24 小时，总数一致且最新记录落在最后一个桶', () => {
    const log = createRequestLog();
    for (let i = 0; i < 5; i++) log.record({ path: `/${i}.txt` });
    const s = computeStats(db, log);
    expect(s.requests.byHour).toHaveLength(24);
    expect(s.requests.byHour.reduce((a, h) => a + h.count, 0)).toBe(5);
    expect(s.requests.byHour[23].count).toBe(5);
  });
});

describe('GET /api/stats', () => {
  it('未登录返回 401', async () => {
    const app = createApp({
      db, requestLog: createRequestLog(),
      config: { sessionTtlHours: 1, cookieSecure: false },
    });
    expect((await app.request('/api/stats', { headers: { host: 'admin.local' } })).status)
      .toBe(401);
  });

  it('登录后返回汇总数据', async () => {
    createUser(db, { username: 'alice', password: 'password1234' });
    createFile(db, { host: 'a.com', filename: 'x.txt', content: 'v', userId: 1 });
    const app = createApp({
      db, requestLog: createRequestLog(),
      config: { sessionTtlHours: 1, cookieSecure: false },
    });
    const login = await app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', host: 'admin.local' },
      body: JSON.stringify({ username: 'alice', password: 'password1234' }),
    });
    const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
    const res = await app.request('/api/stats', { headers: { host: 'admin.local', cookie } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.files.total).toBe(1);
    expect(body.requests.byHour).toHaveLength(24);
  });
});
