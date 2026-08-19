import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db.js';
import { createUser } from '../src/repo/users.js';
import { createDiagnostics } from '../src/diagnostics.js';
import { createApp } from '../src/app.js';

let dir, db, app, superCookie, plainCookie;

async function loginAs(username, password) {
  const res = await app.request('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', host: 'admin.local' },
    body: JSON.stringify({ username, password }),
  });
  return (res.headers.get('set-cookie') || '').split(';')[0];
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'wxr-'));
  db = openDb(join(dir, 'test.db'));
  app = createApp({
    db,
    diagnostics: createDiagnostics(),
    config: { sessionTtlHours: 24, cookieSecure: false },
  });
  createUser(db, { username: 'root', password: 'password1234', isSuper: true });
  createUser(db, { username: 'alice', password: 'password1234' });
  superCookie = await loginAs('root', 'password1234');
  plainCookie = await loginAs('alice', 'password1234');
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

describe('权限', () => {
  it('普通用户访问用户管理一律 403', async () => {
    const api = as(plainCookie);
    expect((await api('/api/users')).status).toBe(403);
    expect((await api('/api/users', 'POST', {})).status).toBe(403);
    expect((await api('/api/users/1', 'DELETE')).status).toBe(403);
  });

  it('未登录返回 401 而非 403', async () => {
    const res = await app.request('/api/users', { headers: { host: 'admin.local' } });
    expect(res.status).toBe(401);
  });
});

describe('GET /api/users', () => {
  it('超管可列出用户，且不含 password_hash', async () => {
    const res = await as(superCookie)('/api/users');
    expect(res.status).toBe(200);
    const rows = await res.json();
    expect(rows).toHaveLength(2);
    expect(JSON.stringify(rows)).not.toContain('password_hash');
  });
});

describe('POST /api/users', () => {
  it('创建成功返回 201', async () => {
    const res = await as(superCookie)('/api/users', 'POST',
      { username: 'bob', password: 'password1234', display_name: 'Bob' });
    expect(res.status).toBe(201);
    expect((await res.json()).username).toBe('bob');
  });

  it('新用户能登录', async () => {
    await as(superCookie)('/api/users', 'POST', { username: 'bob', password: 'password1234' });
    expect(await loginAs('bob', 'password1234')).toMatch(/^sid=/);
  });

  it('新建用户默认不是超管', async () => {
    const res = await as(superCookie)('/api/users', 'POST',
      { username: 'bob', password: 'password1234', is_super: true });
    expect((await res.json()).is_super).toBe(0);
  });

  it('密码过短返回 400', async () => {
    expect((await as(superCookie)('/api/users', 'POST',
      { username: 'bob', password: 'short' })).status).toBe(400);
  });

  it('用户名为空返回 400', async () => {
    expect((await as(superCookie)('/api/users', 'POST',
      { username: '', password: 'password1234' })).status).toBe(400);
  });

  it('用户名重复返回 409', async () => {
    expect((await as(superCookie)('/api/users', 'POST',
      { username: 'alice', password: 'password1234' })).status).toBe(409);
  });
});

describe('DELETE /api/users/:id', () => {
  it('禁用普通用户返回 204，之后无法登录', async () => {
    const users = await (await as(superCookie)('/api/users')).json();
    const alice = users.find(u => u.username === 'alice');
    expect((await as(superCookie)(`/api/users/${alice.id}`, 'DELETE')).status).toBe(204);
    const res = await app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', host: 'admin.local' },
      body: JSON.stringify({ username: 'alice', password: 'password1234' }),
    });
    expect(res.status).toBe(401);
  });

  it('禁用后该用户既有会话立即失效', async () => {
    const users = await (await as(superCookie)('/api/users')).json();
    const alice = users.find(u => u.username === 'alice');
    await as(superCookie)(`/api/users/${alice.id}`, 'DELETE');
    expect((await as(plainCookie)('/api/files')).status).toBe(401);
  });

  it('删除超级管理员返回 403', async () => {
    const users = await (await as(superCookie)('/api/users')).json();
    const root = users.find(u => u.username === 'root');
    expect((await as(superCookie)(`/api/users/${root.id}`, 'DELETE')).status).toBe(403);
  });

  it('不存在的 id 返回 404', async () => {
    expect((await as(superCookie)('/api/users/9999', 'DELETE')).status).toBe(404);
  });
});

describe('POST /api/users/:id/restore', () => {
  it('恢复后可再次登录', async () => {
    const users = await (await as(superCookie)('/api/users')).json();
    const alice = users.find(u => u.username === 'alice');
    await as(superCookie)(`/api/users/${alice.id}`, 'DELETE');
    expect((await as(superCookie)(`/api/users/${alice.id}/restore`, 'POST')).status).toBe(200);
    expect(await loginAs('alice', 'password1234')).toMatch(/^sid=/);
  });

  it('同名启用账号已存在时返回 409', async () => {
    const users = await (await as(superCookie)('/api/users')).json();
    const alice = users.find(u => u.username === 'alice');
    await as(superCookie)(`/api/users/${alice.id}`, 'DELETE');
    await as(superCookie)('/api/users', 'POST', { username: 'alice', password: 'password5678' });
    expect((await as(superCookie)(`/api/users/${alice.id}/restore`, 'POST')).status).toBe(409);
  });
});

describe('POST /api/users/:id/password', () => {
  it('超管重置他人密码后新密码生效', async () => {
    const users = await (await as(superCookie)('/api/users')).json();
    const alice = users.find(u => u.username === 'alice');
    expect((await as(superCookie)(`/api/users/${alice.id}/password`, 'POST',
      { new_password: 'resetpassword99' })).status).toBe(204);
    expect(await loginAs('alice', 'resetpassword99')).toMatch(/^sid=/);
  });

  it('重置后该用户旧会话失效', async () => {
    const users = await (await as(superCookie)('/api/users')).json();
    const alice = users.find(u => u.username === 'alice');
    await as(superCookie)(`/api/users/${alice.id}/password`, 'POST',
      { new_password: 'resetpassword99' });
    expect((await as(plainCookie)('/api/files')).status).toBe(401);
  });

  it('新密码过短返回 400', async () => {
    const users = await (await as(superCookie)('/api/users')).json();
    const alice = users.find(u => u.username === 'alice');
    expect((await as(superCookie)(`/api/users/${alice.id}/password`, 'POST',
      { new_password: 'short' })).status).toBe(400);
  });
});
