import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db.js';
import { createUser } from '../src/repo/users.js';
import { createDiagnostics } from '../src/diagnostics.js';
import { createApp } from '../src/app.js';

let dir, db, app, cookie;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'wxr-'));
  db = openDb(join(dir, 'test.db'));
  app = createApp({
    db,
    diagnostics: createDiagnostics(),
    config: { sessionTtlHours: 24, cookieSecure: false },
  });
  createUser(db, { username: 'alice', password: 'password1234' });
  const res = await app.request('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', host: 'admin.local' },
    body: JSON.stringify({ username: 'alice', password: 'password1234' }),
  });
  cookie = (res.headers.get('set-cookie') || '').split(';')[0];
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const api = (path, method = 'GET', body) =>
  app.request(path, {
    method,
    headers: { 'content-type': 'application/json', host: 'admin.local', cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const anon = (path, method = 'GET', body) =>
  app.request(path, {
    method,
    headers: { 'content-type': 'application/json', host: 'admin.local' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

describe('鉴权', () => {
  it('未登录一律 401', async () => {
    expect((await anon('/api/files')).status).toBe(401);
    expect((await anon('/api/files', 'POST', {})).status).toBe(401);
    expect((await anon('/api/files/1', 'DELETE')).status).toBe(401);
  });
});

describe('POST /api/files', () => {
  it('创建成功返回 201 与记录', async () => {
    const res = await api('/api/files', 'POST',
      { host: 'a.com', filename: 'MP_verify_abc.txt', content: 'abc123', note: '公众号甲' });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.filename).toBe('MP_verify_abc.txt');
    expect(body.created_by_username).toBe('alice');
  });

  it('host 被规范化', async () => {
    const res = await api('/api/files', 'POST',
      { host: 'A.COM:8080', filename: 'x.txt', content: 'v' });
    expect((await res.json()).host).toBe('a.com');
  });

  it('非法文件名返回 400', async () => {
    for (const filename of ['../x.txt', 'a/b.txt', 'x.php', '', 'x.txt.php']) {
      const res = await api('/api/files', 'POST', { host: 'a.com', filename, content: 'v' });
      expect(res.status, filename).toBe(400);
    }
  });

  it('内容超过 4KB 返回 400', async () => {
    const res = await api('/api/files', 'POST',
      { host: 'a.com', filename: 'x.txt', content: 'a'.repeat(4097) });
    expect(res.status).toBe(400);
  });

  it('内容非字符串返回 400', async () => {
    expect((await api('/api/files', 'POST',
      { host: 'a.com', filename: 'x.txt', content: 123 })).status).toBe(400);
  });

  it('重复的 host+filename 返回 409', async () => {
    await api('/api/files', 'POST', { host: 'a.com', filename: 'x.txt', content: 'v1' });
    const res = await api('/api/files', 'POST', { host: 'a.com', filename: 'x.txt', content: 'v2' });
    expect(res.status).toBe(409);
  });

  it('内容原样保存，不做 trim', async () => {
    const res = await api('/api/files', 'POST',
      { host: 'a.com', filename: 'x.txt', content: '  spaced  \n' });
    expect((await res.json()).content).toBe('  spaced  \n');
  });

  it('返回内容体检结果', async () => {
    const res = await api('/api/files', 'POST',
      { host: 'a.com', filename: 'x.txt', content: ' v\r\n' });
    const body = await res.json();
    expect(body.inspect.hasCrlf).toBe(true);
    expect(body.inspect.hasLeadingWhitespace).toBe(true);
  });
});

describe('GET /api/files', () => {
  beforeEach(async () => {
    await api('/api/files', 'POST', { host: 'a.com', filename: 'one.txt', content: 'v', note: '甲' });
    await api('/api/files', 'POST', { host: 'b.com', filename: 'two.txt', content: 'v', note: '乙' });
  });

  it('返回全部未删除记录', async () => {
    expect(await (await api('/api/files')).json()).toHaveLength(2);
  });

  it('按 host 过滤', async () => {
    expect(await (await api('/api/files?host=a.com')).json()).toHaveLength(1);
  });

  it('按 q 搜索', async () => {
    expect(await (await api('/api/files?q=one')).json()).toHaveLength(1);
    expect(await (await api('/api/files?q=乙')).json()).toHaveLength(1);
  });

  it('不返回 password_hash 之类的敏感字段', async () => {
    const rows = await (await api('/api/files')).json();
    expect(JSON.stringify(rows)).not.toContain('password');
  });
});

describe('PUT /api/files/:id', () => {
  it('修改内容并更新 updated_by', async () => {
    const created = await (await api('/api/files', 'POST',
      { host: 'a.com', filename: 'x.txt', content: 'v1' })).json();
    const res = await api(`/api/files/${created.id}`, 'PUT',
      { host: 'a.com', filename: 'x.txt', content: 'v2', note: '改了' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.content).toBe('v2');
    expect(body.updated_by_username).toBe('alice');
  });

  it('改成与另一条冲突的 host+filename 返回 409', async () => {
    await api('/api/files', 'POST', { host: 'a.com', filename: 'x.txt', content: 'v' });
    const b = await (await api('/api/files', 'POST',
      { host: 'a.com', filename: 'y.txt', content: 'v' })).json();
    expect((await api(`/api/files/${b.id}`, 'PUT',
      { host: 'a.com', filename: 'x.txt', content: 'v' })).status).toBe(409);
  });

  it('不存在的 id 返回 404', async () => {
    expect((await api('/api/files/9999', 'PUT',
      { host: 'a.com', filename: 'x.txt', content: 'v' })).status).toBe(404);
  });
});

describe('DELETE 与 restore', () => {
  it('删除是软删除，回收站可见', async () => {
    const f = await (await api('/api/files', 'POST',
      { host: 'a.com', filename: 'x.txt', content: 'v' })).json();
    expect((await api(`/api/files/${f.id}`, 'DELETE')).status).toBe(204);
    expect(await (await api('/api/files')).json()).toHaveLength(0);
    const deleted = await (await api('/api/files?include_deleted=1')).json();
    expect(deleted).toHaveLength(1);
    expect(deleted[0].deleted_by_username).toBe('alice');
  });

  it('恢复后重新出现在列表里', async () => {
    const f = await (await api('/api/files', 'POST',
      { host: 'a.com', filename: 'x.txt', content: 'v' })).json();
    await api(`/api/files/${f.id}`, 'DELETE');
    expect((await api(`/api/files/${f.id}/restore`, 'POST')).status).toBe(200);
    expect(await (await api('/api/files')).json()).toHaveLength(1);
  });

  it('恢复时同名启用记录已存在返回 409', async () => {
    const f = await (await api('/api/files', 'POST',
      { host: 'a.com', filename: 'x.txt', content: 'v1' })).json();
    await api(`/api/files/${f.id}`, 'DELETE');
    await api('/api/files', 'POST', { host: 'a.com', filename: 'x.txt', content: 'v2' });
    expect((await api(`/api/files/${f.id}/restore`, 'POST')).status).toBe(409);
  });
});

describe('POST /api/files/:id/check', () => {
  it('返回内部与外部两层结果', async () => {
    const f = await (await api('/api/files', 'POST',
      { host: '', filename: 'x.txt', content: 'v' })).json();
    const res = await api(`/api/files/${f.id}/check`, 'POST');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.internal.ok).toBe(true);
    expect(body.external.code).toBe('NO_HOST');
  });

  it('不存在的 id 返回 404', async () => {
    expect((await api('/api/files/9999/check', 'POST')).status).toBe(404);
  });
});
