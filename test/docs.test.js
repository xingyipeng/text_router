import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db.js';
import { createUser } from '../src/repo/users.js';
import { createRequestLog } from '../src/requestlog.js';
import { createApp } from '../src/app.js';

let dir, db, app, cookie;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'wxr-docs-'));
  db = openDb(join(dir, 'test.db'));
  const docsDir = join(dir, 'docs');
  mkdirSync(docsDir);
  // fixture：两篇带标题的 md、一篇无标题 md、一个非 md 文件（应被忽略）
  writeFileSync(join(docsDir, 'gateway.md'), '# 网关接入\n\n正文内容\n');
  writeFileSync(join(docsDir, 'tips.md'), '# 小技巧\n\n提示内容\n');
  writeFileSync(join(docsDir, 'plain.md'), '没有标题\n');
  writeFileSync(join(docsDir, 'notes.txt'), 'not a doc\n');

  app = createApp({
    db,
    requestLog: createRequestLog(),
    config: { docsDir, sessionTtlHours: 24, cookieSecure: false },
  });
  createUser(db, { username: 'alice', password: 'password1234' });
  const login = await app.request('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', host: 'admin.local' },
    body: JSON.stringify({ username: 'alice', password: 'password1234' }),
  });
  cookie = (login.headers.get('set-cookie') || '').split(';')[0];
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const req = (path) =>
  app.request(path, { headers: { host: 'admin.local', cookie } });

describe('GET /api/docs', () => {
  it('未登录返回 401', async () => {
    const res = await app.request('/api/docs', { headers: { host: 'admin.local' } });
    expect(res.status).toBe(401);
  });

  it('列出全部 md，忽略非 md 文件，按文件名排序', async () => {
    const rows = await (await req('/api/docs')).json();
    expect(rows.map((r) => r.id)).toEqual(['gateway', 'plain', 'tips']);
  });

  it('标题取首个 # 行，无标题时回落到文件名', async () => {
    const rows = await (await req('/api/docs')).json();
    expect(rows.find((r) => r.id === 'gateway').title).toBe('网关接入');
    expect(rows.find((r) => r.id === 'plain').title).toBe('plain');
  });

  it('普通用户（非超管）也可访问', async () => {
    expect((await req('/api/docs')).status).toBe(200);
  });
});

describe('GET /api/docs/:id', () => {
  it('未登录返回 401', async () => {
    const res = await app.request('/api/docs/gateway', { headers: { host: 'admin.local' } });
    expect(res.status).toBe(401);
  });

  it('返回标题与原文内容', async () => {
    const doc = await (await req('/api/docs/gateway')).json();
    expect(doc).toEqual({ id: 'gateway', title: '网关接入', content: '# 网关接入\n\n正文内容\n' });
  });

  it('不存在的文档返回 404', async () => {
    expect((await req('/api/docs/nope')).status).toBe(404);
  });

  it('路径穿越被拒绝', async () => {
    expect((await req('/api/docs/..%2F..%2Fsecret')).status).toBe(404);
    expect((await req('/api/docs/a%2Fb')).status).toBe(404);
  });
});
