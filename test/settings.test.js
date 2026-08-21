import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db.js';
import { createUser } from '../src/repo/users.js';
import { createRequestLog } from '../src/requestlog.js';
import { createApp } from '../src/app.js';
import { getSettings, setSettings } from '../src/settings.js';

let dir, db, app, requestLog, superCookie, plainCookie;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'wxr-settings-'));
  db = openDb(join(dir, 'test.db'));
  requestLog = createRequestLog();
  app = createApp({
    db,
    requestLog,
    config: { sessionTtlHours: 24, cookieSecure: false },
  });
  createUser(db, { username: 'root', password: 'password1234', isSuper: true });
  createUser(db, { username: 'alice', password: 'password1234' });

  async function loginAs(username) {
    const res = await app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', host: 'admin.local' },
      body: JSON.stringify({ username, password: 'password1234' }),
    });
    return (res.headers.get('set-cookie') || '').split(';')[0];
  }
  superCookie = await loginAs('root');
  plainCookie = await loginAs('alice');
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const as = (cookie) => (path, method = 'GET', body) =>
  app.request(path, {
    method,
    headers: { 'content-type': 'application/json', host: 'admin.local', cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

// ==================== 单元：getSettings / setSettings ====================

describe('getSettings / setSettings（单元）', () => {
  it('TTL 回落链：存储值 → config.sessionTtlHours → 默认 168', () => {
    expect(getSettings(db).session.ttl_hours).toBe(168);
    expect(getSettings(db, { sessionTtlHours: 24 }).session.ttl_hours).toBe(24);
    setSettings(db, { session: { ttl_hours: 720 } });
    expect(getSettings(db, { sessionTtlHours: 24 }).session.ttl_hours).toBe(720);
  });

  it('存储值非法时回落默认值', () => {
    db.prepare(`INSERT INTO settings (key, value) VALUES ('session_ttl_hours', '9999')`).run();
    expect(getSettings(db).session.ttl_hours).toBe(168);
  });

  it('单机登录布尔值按字符串 0/1 存取', () => {
    setSettings(db, { session: { single_session: true } });
    expect(getSettings(db).session.single_session).toBe(true);
    expect(db.prepare(`SELECT value FROM settings WHERE key = 'session_single'`).get().value).toBe('1');
  });
});

// ==================== 路由 /api/settings ====================

describe('GET /api/settings', () => {
  it('未登录 401，普通用户 403', async () => {
    expect((await app.request('/api/settings', { headers: { host: 'admin.local' } })).status).toBe(401);
    expect((await as(plainCookie)('/api/settings')).status).toBe(403);
  });

  it('默认值：TTL 回落 config.sessionTtlHours（24），其余用内置默认', async () => {
    const res = await as(superCookie)('/api/settings');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      backup: { enabled: false, time: '03:17', keep: 14 },
      session: { ttl_hours: 24, single_session: false },
      selfcheck: { timeout_seconds: 8 },
      requestlog: { capacity: 200 },
    });
  });
});

describe('PUT /api/settings', () => {
  it('分组局部更新：只改提交的组，其余保持', async () => {
    const res = await as(superCookie)('/api/settings', 'PUT', {
      session: { ttl_hours: 720, single_session: true },
    });
    expect(res.status).toBe(200);
    const saved = await res.json();
    expect(saved.session).toEqual({ ttl_hours: 720, single_session: true });
    expect(saved.backup).toEqual({ enabled: false, time: '03:17', keep: 14 });
    expect(saved.selfcheck).toEqual({ timeout_seconds: 8 });
    expect(saved.requestlog).toEqual({ capacity: 200 });

    const back = await (await as(superCookie)('/api/settings')).json();
    expect(back.session).toEqual({ ttl_hours: 720, single_session: true });
  });

  it('备份组复用 setBackupSettings 校验', async () => {
    const res = await as(superCookie)('/api/settings', 'PUT',
      { backup: { enabled: true, time: '25:00', keep: 14 } });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('HH:MM');
  });

  it('逐键中文校验错误', async () => {
    const cases = [
      [{ session: { ttl_hours: 0 } }, '1-720'],
      [{ session: { ttl_hours: 721 } }, '1-720'],
      [{ session: { ttl_hours: 1.5 } }, '1-720'],
      [{ session: { single_session: 'yes' } }, '布尔'],
      [{ selfcheck: { timeout_seconds: 2 } }, '3-30'],
      [{ selfcheck: { timeout_seconds: 31 } }, '3-30'],
      [{ requestlog: { capacity: 49 } }, '50-5000'],
      [{ requestlog: { capacity: 5001 } }, '50-5000'],
    ];
    for (const [body, msg] of cases) {
      const res = await as(superCookie)('/api/settings', 'PUT', body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect((await res.json()).error, JSON.stringify(body)).toContain(msg);
    }
  });

  it('坏 JSON / 非对象 400', async () => {
    expect((await as(superCookie)('/api/settings', 'PUT', 'oops')).status).toBe(400);
    expect((await as(superCookie)('/api/settings', 'PUT', [1])).status).toBe(400);
  });

  it('校验失败时事务整体回滚：合法键不被部分写入', async () => {
    const res = await as(superCookie)('/api/settings', 'PUT', {
      session: { ttl_hours: 100 },
      requestlog: { capacity: 999999 }, // 非法 → 整体回滚
    });
    expect(res.status).toBe(400);
    const back = await (await as(superCookie)('/api/settings')).json();
    expect(back.session.ttl_hours).toBe(24);
    expect(back.requestlog.capacity).toBe(200);
  });

  it('请求记录容量改后立即生效（裁剪内存记录）', async () => {
    for (let i = 0; i < 100; i++) requestLog.record({ hit: true });
    expect(requestLog.list()).toHaveLength(100);
    const res = await as(superCookie)('/api/settings', 'PUT', { requestlog: { capacity: 50 } });
    expect(res.status).toBe(200);
    expect((await res.json()).requestlog.capacity).toBe(50);
    expect(requestLog.list()).toHaveLength(50);
  });
});
