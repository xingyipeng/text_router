import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db.js';
import { createFile, softDeleteFile } from '../src/repo/files.js';
import { createDiagnostics } from '../src/diagnostics.js';
import { createApp } from '../src/app.js';

let dir, db, diagnostics, app;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wxr-'));
  db = openDb(join(dir, 'test.db'));
  diagnostics = createDiagnostics();
  app = createApp({ db, diagnostics, config: { sessionTtlHours: 1, cookieSecure: false } });
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const get = (path, host = 'a.com', extra = {}) =>
  app.request(path, { headers: { host, ...extra } });

describe('GET /{name}.txt', () => {
  it('命中时返回 200 与精确内容', async () => {
    createFile(db, { host: 'a.com', filename: 'MP_verify_abc.txt', content: 'abc123', userId: 1 });
    const res = await get('/MP_verify_abc.txt');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('abc123');
  });

  it('响应头正确', async () => {
    createFile(db, { host: 'a.com', filename: 'x.txt', content: 'v', userId: 1 });
    const res = await get('/x.txt');
    expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('未命中返回 404 且不泄露已有文件名', async () => {
    createFile(db, { host: 'a.com', filename: 'secret.txt', content: 'v', userId: 1 });
    const res = await get('/other.txt');
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain('secret');
  });

  it('跨 host 隔离：a.com 的文件在 b.com 上 404', async () => {
    createFile(db, { host: 'a.com', filename: 'x.txt', content: 'v', userId: 1 });
    expect((await get('/x.txt', 'b.com')).status).toBe(404);
  });

  it('全局记录在任何 host 上都命中', async () => {
    createFile(db, { host: '', filename: 'g.txt', content: 'global', userId: 1 });
    expect(await (await get('/g.txt', 'whatever.com')).text()).toBe('global');
  });

  it('X-Forwarded-Host 优先于 Host', async () => {
    createFile(db, { host: 'real.com', filename: 'x.txt', content: 'v', userId: 1 });
    const res = await get('/x.txt', 'gateway.internal', { 'x-forwarded-host': 'real.com' });
    expect(res.status).toBe(200);
  });

  it('host 大小写与端口被规范化', async () => {
    createFile(db, { host: 'a.com', filename: 'x.txt', content: 'v', userId: 1 });
    expect((await get('/x.txt', 'A.COM:8080')).status).toBe(200);
  });

  it('内容逐字节返回，保留尾部换行', async () => {
    createFile(db, { host: 'a.com', filename: 'x.txt', content: 'line\n', userId: 1 });
    expect(await (await get('/x.txt')).text()).toBe('line\n');
  });

  it('内容支持 Unicode', async () => {
    createFile(db, { host: 'a.com', filename: 'x.txt', content: '中文内容', userId: 1 });
    expect(await (await get('/x.txt')).text()).toBe('中文内容');
  });

  it('软删除后返回 404', async () => {
    const f = createFile(db, { host: 'a.com', filename: 'x.txt', content: 'v', userId: 1 });
    softDeleteFile(db, f.id, 1);
    expect((await get('/x.txt')).status).toBe(404);
  });

  it('多段路径不被当作校验文件', async () => {
    expect((await get('/sub/x.txt')).status).toBe(404);
  });

  it('路径穿越不命中', async () => {
    createFile(db, { host: 'a.com', filename: 'x.txt', content: 'v', userId: 1 });
    expect((await get('/..%2Fx.txt')).status).toBe(404);
    expect((await get('/%2E%2E%2Fetc%2Fpasswd.txt')).status).toBe(404);
  });

  it('非 .txt 后缀不进入校验文件处理器', async () => {
    expect((await get('/x.php')).status).toBe(404);
  });
});

describe('诊断记录', () => {
  it('命中与未命中都被记录', async () => {
    createFile(db, { host: 'a.com', filename: 'x.txt', content: 'v', userId: 1 });
    await get('/x.txt');
    await get('/missing.txt');
    const entries = diagnostics.list();
    expect(entries).toHaveLength(2);
    expect(entries[0].hit).toBe(false);
    expect(entries[1].hit).toBe(true);
  });

  it('记录原始 Host 与解析后的 host', async () => {
    await get('/x.txt', 'GATEWAY.internal:8080', { 'x-forwarded-host': 'Real.COM' });
    const e = diagnostics.list()[0];
    expect(e.host).toBe('GATEWAY.internal:8080');
    expect(e.forwardedHost).toBe('Real.COM');
    expect(e.resolvedHost).toBe('real.com');
  });
});
