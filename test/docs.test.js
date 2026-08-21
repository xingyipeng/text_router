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
  const groupDir = join(docsDir, '网关接入');
  mkdirSync(groupDir, { recursive: true });
  // fixture：顶层两篇 md（一篇无标题）、一个非 md 文件（应被忽略）；子目录分组两篇 md
  writeFileSync(join(docsDir, 'tips.md'), '# 小技巧\n\n提示内容\n');
  writeFileSync(join(docsDir, 'plain.md'), '没有标题\n');
  writeFileSync(join(docsDir, 'notes.txt'), 'not a doc\n');
  writeFileSync(join(groupDir, 'nginx.md'), '# Nginx 接入\n\nproxy_pass 配置\n');
  writeFileSync(join(groupDir, 'traefik.md'), '# Traefik 接入\n\nPathRegexp 配置\n');

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

  it('顶层文档（group 为空）在前，分组文档在后，忽略非 md，按文件名排序', async () => {
    const rows = await (await req('/api/docs')).json();
    expect(rows.map((r) => `${r.group}:${r.id}`)).toEqual([
      ':plain',
      ':tips',
      '网关接入:nginx',
      '网关接入:traefik',
    ]);
  });

  it('标题取首个 # 行，无标题时回落到文件名', async () => {
    const rows = await (await req('/api/docs')).json();
    expect(rows.find((r) => r.id === 'nginx').title).toBe('Nginx 接入');
    expect(rows.find((r) => r.id === 'plain').title).toBe('plain');
  });

  it('普通用户（非超管）也可访问', async () => {
    expect((await req('/api/docs')).status).toBe(200);
  });
});

describe('GET /api/docs/:group/:name 与 /api/docs/:id', () => {
  it('分组文档返回标题与原文内容', async () => {
    const doc = await (await req(`/api/docs/${encodeURIComponent('网关接入')}/nginx`)).json();
    expect(doc).toEqual({
      id: 'nginx',
      title: 'Nginx 接入',
      content: '# Nginx 接入\n\nproxy_pass 配置\n',
    });
  });

  it('顶层文档仍可直接访问', async () => {
    const doc = await (await req('/api/docs/tips')).json();
    expect(doc).toEqual({ id: 'tips', title: '小技巧', content: '# 小技巧\n\n提示内容\n' });
  });

  it('顶层不存在的 id 返回 404（不会落到分组）', async () => {
    expect((await req('/api/docs/nginx')).status).toBe(404);
  });

  it('分组内不存在的文档返回 404', async () => {
    expect((await req(`/api/docs/${encodeURIComponent('网关接入')}/nope`)).status).toBe(404);
  });

  it('路径穿越被拒绝', async () => {
    expect((await req('/api/docs/..%2F..%2Fsecret')).status).toBe(404);
    expect((await req('/api/docs/a%2Fb')).status).toBe(404);
    expect((await req('/api/docs/%2E%2E/nginx')).status).toBe(404); // group 为 ..
    expect((await req('/api/docs/%2Ehidden/nginx')).status).toBe(404); // group 以 . 开头
  });
});
