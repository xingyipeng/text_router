import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db.js';
import { createUser, listUsers, findActiveByUsername } from '../src/repo/users.js';
import { verifyPassword } from '../src/password.js';
import { ensureSuperAdmin, resetSuperPassword } from '../src/init.js';
import { createRequestLog } from '../src/requestLog.js';
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

describe('ensureSuperAdmin', () => {
  it('空库时创建超管', () => {
    const r = ensureSuperAdmin(db, { username: 'root', password: 'password1234' });
    expect(r.created).toBe(true);
    const users = listUsers(db);
    expect(users).toHaveLength(1);
    expect(users[0].is_super).toBe(1);
  });

  it('创建的超管密码可校验', () => {
    ensureSuperAdmin(db, { username: 'root', password: 'password1234' });
    const row = findActiveByUsername(db, 'root');
    expect(verifyPassword('password1234', row.password_hash)).toBe(true);
  });

  it('空库且未设置环境变量时用默认账号 admin/admin123 创建超管', () => {
    const r = ensureSuperAdmin(db, {});
    expect(r.created).toBe(true);
    expect(r.username).toBe('admin');
    expect(r.defaultedUsername).toBe(true);
    expect(r.defaultedPassword).toBe(true);
    const row = findActiveByUsername(db, 'admin');
    expect(row.is_super).toBe(1);
    expect(verifyPassword('admin123', row.password_hash)).toBe(true);
  });

  it('只设置用户名时密码用默认值', () => {
    const r = ensureSuperAdmin(db, { username: 'root' });
    expect(r.created).toBe(true);
    expect(r.defaultedPassword).toBe(true);
    const row = findActiveByUsername(db, 'root');
    expect(verifyPassword('admin123', row.password_hash)).toBe(true);
  });

  it('显式设置全部变量时不走默认值', () => {
    const r = ensureSuperAdmin(db, { username: 'root', password: 'password1234' });
    expect(r.defaultedUsername).toBe(false);
    expect(r.defaultedPassword).toBe(false);
  });

  it('空库且显式设置的密码过短时抛错', () => {
    expect(() => ensureSuperAdmin(db, { username: 'root', password: 'short' }))
      .toThrow(/至少/);
  });

  it('非空库时忽略环境变量，不重置已有账号', () => {
    createUser(db, { username: 'alice', password: 'password1234' });
    const r = ensureSuperAdmin(db, { username: 'root', password: 'password1234' });
    expect(r.created).toBe(false);
    expect(listUsers(db)).toHaveLength(1);
    expect(findActiveByUsername(db, 'root')).toBeUndefined();
  });

  it('库里只有已禁用用户时也算非空，不再创建超管', () => {
    const u = createUser(db, { username: 'alice', password: 'password1234' });
    db.prepare('UPDATE users SET disabled_at = ? WHERE id = ?').run(Date.now(), u.id);
    expect(ensureSuperAdmin(db, { username: 'root', password: 'password1234' }).created).toBe(false);
  });
});

describe('resetSuperPassword', () => {
  it('重置超管密码，新密码可校验', () => {
    ensureSuperAdmin(db, { username: 'root', password: 'password1234' });
    const r = resetSuperPassword(db, 'brandnewpassword');
    expect(r.username).toBe('root');
    const row = findActiveByUsername(db, 'root');
    expect(verifyPassword('brandnewpassword', row.password_hash)).toBe(true);
    expect(verifyPassword('password1234', row.password_hash)).toBe(false);
  });

  it('清除超管的所有会话', () => {
    ensureSuperAdmin(db, { username: 'root', password: 'password1234' });
    const su = findActiveByUsername(db, 'root');
    db.prepare('INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?,?,?,?)')
      .run('tok', su.id, Date.now(), Date.now() + 100000);
    resetSuperPassword(db, 'brandnewpassword');
    expect(db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n).toBe(0);
  });

  it('顺带解除超管的禁用状态', () => {
    ensureSuperAdmin(db, { username: 'root', password: 'password1234' });
    db.prepare('UPDATE users SET disabled_at = ? WHERE is_super = 1').run(Date.now());
    resetSuperPassword(db, 'brandnewpassword');
    expect(findActiveByUsername(db, 'root')).toBeDefined();
  });

  it('没有超管时抛错', () => {
    createUser(db, { username: 'alice', password: 'password1234' });
    expect(() => resetSuperPassword(db, 'brandnewpassword')).toThrow(/未找到超级管理员/);
  });

  it('新密码过短时抛错', () => {
    ensureSuperAdmin(db, { username: 'root', password: 'password1234' });
    expect(() => resetSuperPassword(db, 'short')).toThrow(/至少/);
  });
});

describe('GET /api/request-log', () => {
  it('未登录返回 401', async () => {
    const app = createApp({
      db, requestLog: createRequestLog(),
      config: { sessionTtlHours: 24, cookieSecure: false },
    });
    expect((await app.request('/api/request-log',
      { headers: { host: 'admin.local' } })).status).toBe(401);
  });

  it('登录后返回最近请求，最新在前', async () => {
    const requestLog = createRequestLog();
    const app = createApp({
      db, requestLog,
      config: { sessionTtlHours: 24, cookieSecure: false },
    });
    createUser(db, { username: 'alice', password: 'password1234' });
    const login = await app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', host: 'admin.local' },
      body: JSON.stringify({ username: 'alice', password: 'password1234' }),
    });
    const cookie = (login.headers.get('set-cookie') || '').split(';')[0];

    await app.request('/first.txt', { headers: { host: 'a.com' } });
    await app.request('/second.txt', { headers: { host: 'a.com' } });

    const res = await app.request('/api/request-log',
      { headers: { host: 'admin.local', cookie } });
    const rows = await res.json();
    expect(rows[0].filename).toBe('second.txt');
    expect(rows[0].hit).toBe(false);
  });
});

describe('POST /api/request-log/clear', () => {
  it('未登录返回 401', async () => {
    const app = createApp({
      db, requestLog: createRequestLog(),
      config: { sessionTtlHours: 24, cookieSecure: false },
    });
    expect((await app.request('/api/request-log/clear', {
      method: 'POST', headers: { host: 'admin.local' },
    })).status).toBe(401);
  });

  it('清空后列表为空', async () => {
    const requestLog = createRequestLog();
    const app = createApp({
      db, requestLog,
      config: { sessionTtlHours: 24, cookieSecure: false },
    });
    createUser(db, { username: 'alice', password: 'password1234' });
    const login = await app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', host: 'admin.local' },
      body: JSON.stringify({ username: 'alice', password: 'password1234' }),
    });
    const cookie = (login.headers.get('set-cookie') || '').split(';')[0];

    await app.request('/first.txt', { headers: { host: 'a.com' } });
    expect(await (await app.request('/api/request-log',
      { headers: { host: 'admin.local', cookie } })).json()).toHaveLength(1);

    const res = await app.request('/api/request-log/clear', {
      method: 'POST', headers: { host: 'admin.local', cookie },
    });
    expect(res.status).toBe(200);
    expect(await (await app.request('/api/request-log',
      { headers: { host: 'admin.local', cookie } })).json()).toHaveLength(0);
  });
});
