import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db.js';
import { createFile, softDeleteFile } from '../src/repo/rules.js';
import { createRequestLog } from '../src/requestLog.js';
import { createApp } from '../src/app.js';

let dir, db, requestLog, app;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wxr-'));
  db = openDb(join(dir, 'test.db'));
  requestLog = createRequestLog();
  app = createApp({ db, requestLog, config: { sessionTtlHours: 1, cookieSecure: false } });
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

  it('子目录路径无记录时 404', async () => {
    expect((await get('/sub/x.txt')).status).toBe(404);
  });

  it('子目录路径命中', async () => {
    createFile(db, { host: 'a.com', filename: 'sub/x.txt', content: 'sub', userId: 1 });
    expect(await (await get('/sub/x.txt')).text()).toBe('sub');
  });

  it('深层子目录路径命中', async () => {
    createFile(db, { host: 'a.com', filename: 'a/b/c/x.txt', content: 'deep', userId: 1 });
    expect(await (await get('/a/b/c/x.txt')).text()).toBe('deep');
  });

  it('子目录路径跨域名隔离', async () => {
    createFile(db, { host: 'a.com', filename: 'sub/x.txt', content: 'v', userId: 1 });
    expect((await get('/sub/x.txt', 'b.com')).status).toBe(404);
  });

  it('全局记录命中子目录路径', async () => {
    createFile(db, { host: '', filename: 'h5/g.txt', content: 'global', userId: 1 });
    expect(await (await get('/h5/g.txt', 'whatever.com')).text()).toBe('global');
  });

  it('根路径与子目录同名记录互不影响', async () => {
    createFile(db, { host: 'a.com', filename: 'x.txt', content: 'root', userId: 1 });
    createFile(db, { host: 'a.com', filename: 'sub/x.txt', content: 'sub', userId: 1 });
    expect(await (await get('/x.txt')).text()).toBe('root');
    expect(await (await get('/sub/x.txt')).text()).toBe('sub');
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

describe('更多域名与路径场景', () => {
  it('同一文件名在不同域名返回各自内容', async () => {
    createFile(db, { host: 'a.com', filename: 'x.txt', content: 'for-a', userId: 1 });
    createFile(db, { host: 'b.com', filename: 'x.txt', content: 'for-b', userId: 1 });
    expect(await (await get('/x.txt', 'a.com')).text()).toBe('for-a');
    expect(await (await get('/x.txt', 'b.com')).text()).toBe('for-b');
  });

  it('精确域名记录优先于全局记录', async () => {
    createFile(db, { host: '', filename: 'x.txt', content: 'global', userId: 1 });
    createFile(db, { host: 'a.com', filename: 'x.txt', content: 'exact', userId: 1 });
    expect(await (await get('/x.txt', 'a.com')).text()).toBe('exact');
    expect(await (await get('/x.txt', 'other.com')).text()).toBe('global');
  });

  it('查询字符串不影响命中', async () => {
    createFile(db, { host: 'a.com', filename: 'x.txt', content: 'v', userId: 1 });
    const res = await get('/x.txt?foo=1&bar=2');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('v');
  });

  it('尾部斜杠不命中', async () => {
    createFile(db, { host: 'a.com', filename: 'x.txt', content: 'v', userId: 1 });
    expect((await get('/x.txt/')).status).toBe(404);
  });

  it('扩展名大小写敏感：.TXT 不命中', async () => {
    createFile(db, { host: 'a.com', filename: 'x.txt', content: 'v', userId: 1 });
    expect((await get('/x.TXT')).status).toBe(404);
  });

  it('根路径与目录路径不命中', async () => {
    expect((await get('/')).status).toBe(404);
    expect((await get('/sub/')).status).toBe(404);
  });

  it('缺少 Host 头时只命中全局记录，域名绑定记录不命中', async () => {
    createFile(db, { host: '', filename: 'g.txt', content: 'global', userId: 1 });
    createFile(db, { host: 'a.com', filename: 'x.txt', content: 'v', userId: 1 });
    expect(await (await app.request('/g.txt')).text()).toBe('global');
    expect((await app.request('/x.txt')).status).toBe(404);
  });

  it('X-Forwarded-Host 的大小写与端口被规范化', async () => {
    createFile(db, { host: 'real.com', filename: 'x.txt', content: 'v', userId: 1 });
    expect((await get('/x.txt', 'gateway.internal', { 'x-forwarded-host': 'REAL.COM:443' })).status).toBe(200);
  });

  it('多值 X-Forwarded-Host 只取第一个', async () => {
    createFile(db, { host: 'real.com', filename: 'x.txt', content: 'v', userId: 1 });
    expect((await get('/x.txt', 'gateway.internal', { 'x-forwarded-host': 'real.com, evil.com' })).status).toBe(200);
  });

  it('主机名尾部的点被去掉', async () => {
    createFile(db, { host: 'a.com', filename: 'x.txt', content: 'v', userId: 1 });
    expect((await get('/x.txt', 'a.com.')).status).toBe(200);
  });

  it('文件名恰好 80 字符命中，81 字符不命中', async () => {
    const name80 = 'a'.repeat(80) + '.txt';
    createFile(db, { host: 'a.com', filename: name80, content: 'v', userId: 1 });
    expect((await get(`/${name80}`)).status).toBe(200);
    expect((await get(`/${'b'.repeat(81)}.txt`)).status).toBe(404);
  });

  it('文件名含非法字符不命中', async () => {
    createFile(db, { host: 'a.com', filename: 'x.txt', content: 'v', userId: 1 });
    expect((await get('/x y.txt')).status).toBe(404);
    expect((await get('/校验文件.txt')).status).toBe(404);
    expect((await get('/x..txt')).status).toBe(404);
  });
});

describe('内容逐字节返回', () => {
  it('CRLF 原样返回，不转换', async () => {
    createFile(db, { host: 'a.com', filename: 'x.txt', content: 'a\r\nb\r\n', userId: 1 });
    expect(await (await get('/x.txt')).text()).toBe('a\r\nb\r\n');
  });

  it('BOM 原样返回（线上字节含 BOM，text() 解码时才会剥掉）', async () => {
    createFile(db, { host: 'a.com', filename: 'x.txt', content: '\ufeffabc123', userId: 1 });
    const bytes = Buffer.from(await (await get('/x.txt')).arrayBuffer());
    expect(bytes).toEqual(Buffer.from('\ufeffabc123', 'utf8'));
  });

  it('4096 字节内容完整返回', async () => {
    const big = 'a'.repeat(4096);
    createFile(db, { host: 'a.com', filename: 'x.txt', content: big, userId: 1 });
    expect(await (await get('/x.txt')).text()).toBe(big);
  });
});

describe('请求记录', () => {
  it('命中与未命中都被记录', async () => {
    createFile(db, { host: 'a.com', filename: 'x.txt', content: 'v', userId: 1 });
    await get('/x.txt');
    await get('/missing.txt');
    const entries = requestLog.list();
    expect(entries).toHaveLength(2);
    expect(entries[0].hit).toBe(false);
    expect(entries[1].hit).toBe(true);
  });

  it('记录原始 Host 与解析后的 host', async () => {
    await get('/x.txt', 'GATEWAY.internal:8080', { 'x-forwarded-host': 'Real.COM' });
    const e = requestLog.list()[0];
    expect(e.host).toBe('GATEWAY.internal:8080');
    expect(e.forwardedHost).toBe('Real.COM');
    expect(e.resolvedHost).toBe('real.com');
  });
});
