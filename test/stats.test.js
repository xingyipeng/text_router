import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db.js';
import { createFile } from '../src/repo/rules.js';
import { createUser } from '../src/repo/users.js';
import { createRequestLog } from '../src/requestlog.js';
import { computeStats, mainDomain } from '../src/stats.js';
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

describe('mainDomain', () => {
  it('常规域名取最后两段', () => {
    expect(mainDomain('saitron-m.com')).toBe('saitron-m.com');
    expect(mainDomain('wx-router.saitron-m.com')).toBe('saitron-m.com');
  });

  it('剥掉通配标签后再取主域', () => {
    expect(mainDomain('*.naodu.com')).toBe('naodu.com');
    expect(mainDomain('*.**.naodu.com')).toBe('naodu.com');
    expect(mainDomain('a.*.com')).toBe('a.com');
  });

  it('双段后缀取三段', () => {
    expect(mainDomain('a.com.cn')).toBe('a.com.cn');
    expect(mainDomain('sub.b.com.cn')).toBe('b.com.cn');
  });

  it('纯通配无法归类返回空串', () => {
    expect(mainDomain('*.**')).toBe('');
    expect(mainDomain('*')).toBe('');
  });
});

describe('computeStats', () => {
  it('统计文件总数、绑定/全局数与两种域名口径', () => {
    createFile(db, { host: 'a.com', filename: 'x.txt', content: 'v', userId: 1 });
    createFile(db, { host: 'a.com', filename: 'y.txt', content: 'v', userId: 1 });
    createFile(db, { host: '*', filename: 'g.txt', content: 'v', userId: 1 });
    const s = computeStats(db, createRequestLog());
    expect(s.files.total).toBe(3);
    expect(s.files.bound).toBe(2);
    expect(s.files.global).toBe(1);
    expect(s.files.domains).toBe(1);
    expect(s.files.byMainDomain).toEqual([{ host: 'a.com', count: 2 }]);
    expect(s.files.byRuleHost).toEqual([{ host: 'a.com', count: 2 }]);
  });

  it('模式记录计入绑定数，按规则视图不隐藏、主域名视图聚合', () => {
    createFile(db, { host: '*.a.com', filename: 'p.txt', content: 'v', userId: 1 });
    createFile(db, { host: '*', filename: 'g.txt', content: 'v', userId: 1 });
    createFile(db, { host: 'a.com', filename: 'x.txt', content: 'v', userId: 1 });
    const s = computeStats(db, createRequestLog());
    expect(s.files.total).toBe(3);
    expect(s.files.global).toBe(1);
    expect(s.files.bound).toBe(2);
    expect(s.files.byRuleHost).toEqual([
      { host: '*.a.com', count: 1 },
      { host: 'a.com', count: 1 },
    ]);
    expect(s.files.byMainDomain).toEqual([{ host: 'a.com', count: 2 }]);
  });

  it('按主域名合并子域名，按规则保持分开', () => {
    createFile(db, { host: 'wx-router.saitron-m.com', filename: 'x.txt', content: 'v', userId: 1 });
    createFile(db, { host: 'saitron-m.com', filename: 'y.txt', content: 'v', userId: 1 });
    createFile(db, { host: 'saitron-m.com', filename: 'z.txt', content: 'v', userId: 1 });
    const s = computeStats(db, createRequestLog());
    expect(s.files.byMainDomain).toEqual([{ host: 'saitron-m.com', count: 3 }]);
    expect(s.files.byRuleHost).toEqual([
      { host: 'saitron-m.com', count: 2 },
      { host: 'wx-router.saitron-m.com', count: 1 },
    ]);
  });

  it('com.cn 双段后缀主域互不混淆', () => {
    createFile(db, { host: 'a.com.cn', filename: 'x.txt', content: 'v', userId: 1 });
    createFile(db, { host: 'sub.b.com.cn', filename: 'y.txt', content: 'v', userId: 1 });
    const s = computeStats(db, createRequestLog());
    expect(s.files.byMainDomain).toEqual([
      { host: 'a.com.cn', count: 1 },
      { host: 'b.com.cn', count: 1 },
    ]);
  });

  it('纯通配模式不出现在主域名视图，按规则仍显示', () => {
    createFile(db, { host: '*.**', filename: 'x.txt', content: 'v', userId: 1 });
    const s = computeStats(db, createRequestLog());
    expect(s.files.byMainDomain).toEqual([]);
    expect(s.files.byRuleHost).toEqual([{ host: '*.**', count: 1 }]);
  });

  it('按主域名数量降序', () => {
    createFile(db, { host: 'a.com', filename: 'x.txt', content: 'v', userId: 1 });
    createFile(db, { host: 'b.com', filename: 'y.txt', content: 'v', userId: 1 });
    createFile(db, { host: 'b.com', filename: 'z.txt', content: 'v', userId: 1 });
    const s = computeStats(db, createRequestLog());
    expect(s.files.byMainDomain.map((d) => d.host)).toEqual(['b.com', 'a.com']);
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

  it('最近请求：最新在前、最多 5 条，拼成完整 URL', () => {
    const log = createRequestLog();
    for (let i = 0; i < 7; i++) {
      log.record({ host: 'h.com', resolvedHost: 'r.com', path: `/${i}.txt`, hit: i % 2 === 0 });
    }
    const s = computeStats(db, log);
    expect(s.requests.recent).toHaveLength(5);
    expect(s.requests.recent[0]).toEqual({
      at: expect.any(Number), url: 'http://r.com/6.txt', hit: true,
    });
    expect(s.requests.recent[4].url).toBe('http://r.com/2.txt');
  });

  it('最近请求：scheme 取记录值，无 resolvedHost 时回退 host', () => {
    const log = createRequestLog();
    log.record({ host: 'h.com', path: '/x.txt', hit: false, scheme: 'https' });
    const s = computeStats(db, log);
    expect(s.requests.recent[0].url).toBe('https://h.com/x.txt');
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
