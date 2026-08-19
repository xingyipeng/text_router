import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db.js';
import { createUser, disableUser } from '../src/repo/users.js';
import { createDiagnostics } from '../src/diagnostics.js';
import { createApp } from '../src/app.js';

let dir, db, app;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wxr-'));
  db = openDb(join(dir, 'test.db'));
  app = createApp({
    db,
    diagnostics: createDiagnostics(),
    config: { sessionTtlHours: 24, cookieSecure: false },
  });
  createUser(db, { username: 'alice', password: 'password1234', displayName: 'Alice' });
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const post = (path, body, headers = {}) =>
  app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', host: 'admin.local', ...headers },
    body: JSON.stringify(body),
  });

async function login(username = 'alice', password = 'password1234') {
  const res = await post('/api/auth/login', { username, password });
  const cookie = res.headers.get('set-cookie') || '';
  return cookie.split(';')[0];
}

describe('POST /api/auth/login', () => {
  it('正确凭据返回 200 并下发 cookie', async () => {
    const res = await post('/api/auth/login', { username: 'alice', password: 'password1234' });
    expect(res.status).toBe(200);
    const cookie = res.headers.get('set-cookie');
    expect(cookie).toMatch(/^sid=/);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
  });

  it('cookieSecure 为 false 时不带 Secure 标志', async () => {
    const res = await post('/api/auth/login', { username: 'alice', password: 'password1234' });
    expect(res.headers.get('set-cookie')).not.toContain('Secure');
  });

  it('密码错误返回 401', async () => {
    expect((await post('/api/auth/login', { username: 'alice', password: 'wrongpassword' })).status)
      .toBe(401);
  });

  it('用户不存在返回 401，且与密码错误的响应无差别', async () => {
    const a = await post('/api/auth/login', { username: 'nobody', password: 'password1234' });
    const b = await post('/api/auth/login', { username: 'alice', password: 'wrongpassword' });
    expect(a.status).toBe(401);
    expect(await a.text()).toBe(await b.text());
  });

  it('已禁用用户无法登录', async () => {
    const u = createUser(db, { username: 'bob', password: 'password1234' });
    disableUser(db, u.id);
    expect((await post('/api/auth/login', { username: 'bob', password: 'password1234' })).status)
      .toBe(401);
  });
});

describe('GET /api/auth/me', () => {
  it('未登录返回 401 而非 302', async () => {
    const res = await app.request('/api/auth/me', { headers: { host: 'admin.local' } });
    expect(res.status).toBe(401);
    expect(res.headers.get('location')).toBeNull();
    expect(res.headers.get('content-type')).toContain('application/json');
  });

  it('登录后返回用户信息，不含 password_hash', async () => {
    const cookie = await login();
    const res = await app.request('/api/auth/me', { headers: { host: 'admin.local', cookie } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.username).toBe('alice');
    expect(body.password_hash).toBeUndefined();
  });
});

describe('POST /api/auth/logout', () => {
  it('登出后 cookie 失效', async () => {
    const cookie = await login();
    await post('/api/auth/logout', {}, { cookie });
    const res = await app.request('/api/auth/me', { headers: { host: 'admin.local', cookie } });
    expect(res.status).toBe(401);
  });
});

describe('POST /api/auth/password', () => {
  it('改密成功后补发新会话，新 cookie 可用', async () => {
    const cookie = await login();
    const res = await post('/api/auth/password',
      { old_password: 'password1234', new_password: 'newpassword9999' }, { cookie });
    expect(res.status).toBe(200);
    const newCookie = (res.headers.get('set-cookie') || '').split(';')[0];
    const me = await app.request('/api/auth/me',
      { headers: { host: 'admin.local', cookie: newCookie } });
    expect(me.status).toBe(200);
  });

  it('改密后旧密码不能再登录', async () => {
    const cookie = await login();
    await post('/api/auth/password',
      { old_password: 'password1234', new_password: 'newpassword9999' }, { cookie });
    expect((await post('/api/auth/login', { username: 'alice', password: 'password1234' })).status)
      .toBe(401);
    expect((await post('/api/auth/login', { username: 'alice', password: 'newpassword9999' })).status)
      .toBe(200);
  });

  it('旧密码不对返回 400', async () => {
    const cookie = await login();
    expect((await post('/api/auth/password',
      { old_password: 'nope', new_password: 'newpassword9999' }, { cookie })).status).toBe(400);
  });

  it('新密码过短返回 400', async () => {
    const cookie = await login();
    expect((await post('/api/auth/password',
      { old_password: 'password1234', new_password: 'short' }, { cookie })).status).toBe(400);
  });

  it('未登录返回 401', async () => {
    expect((await post('/api/auth/password',
      { old_password: 'a', new_password: 'password1234' })).status).toBe(401);
  });
});
