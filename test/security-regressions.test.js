import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';
import { openDb } from '../src/db.js';
import { createApp } from '../src/app.js';
import { createRequestLog } from '../src/requestlog.js';
import { createUser } from '../src/repo/users.js';
import { createSession } from '../src/repo/sessions.js';
import { createFile, matchFile } from '../src/repo/rules.js';
import { matchHost, normalizePattern } from '../src/hostmatch.js';
import { runExternalCheck } from '../src/selfcheck.js';
import { safeLookup, checkTarget, isPublicAddress } from '../src/safe-fetch.js';
import { createLoginLimiter } from '../src/login-limit.js';
import { verifyPasswordAsync, hashPassword } from '../src/password.js';
import { createBatchCheck, getBatchCheck, _test } from '../src/batchcheck.js';
import { getBackupSettings, setBackupSettings, maybeRunScheduledBackup, runBackup } from '../src/backup.js';

let dir, db, app, cookie;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'router-regression-'));
  db = openDb(join(dir, 'test.db'));
  app = createApp({ db, requestLog: createRequestLog(50), config: { sessionTtlHours: 1, staticRoot: './public' } });
  const user = createUser(db, { username: 'ordinary', password: 'test-password' });
  cookie = 'sid=' + createSession(db, user.id, 1);
});
afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }); vi.restoreAllMocks(); });
const post = (path, body) => app.request(path, {
  method: 'POST', headers: { cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

describe('管理接口与文本规则隔离', () => {
  it.each(['api/docs/rules-guide', 'api/auth/me', 'api/users', 'index.html', 'main.js', 'vendor/purify.min.js', '%61pi/docs/rules-guide'])('禁止创建保留路径 %s', async (filename) => {
    expect((await post('/api/rules', { host: '*', filename, content: 'x' })).status).toBe(400);
  });
  it('旧数据库中的冲突规则不能替换文档接口、会话或脚本', async () => {
    for (const filename of ['api/docs/rules-guide', 'api/auth/me', 'main.js']) {
      createFile(db, { host: '*', filename, content: 'malicious', userId: 1 });
    }
    expect((await app.request('/api/docs/rules-guide')).status).toBe(401);
    expect((await app.request('/api/auth/me')).status).toBe(401);
    const res = await app.request('/main.js');
    expect(res.status).toBe(200);
    expect(await res.text()).not.toContain('malicious');
    expect((await app.request('/api/docs/rules-guide', { headers: { cookie } })).status).toBe(200);
  });
  it('导入与编辑同样拒绝保留路径，正常校验仍可公开访问', async () => {
    const created = await post('/api/rules', { host: '*', filename: '.well-known/test.txt', content: 'verify' });
    const row = await created.json();
    const edit = await app.request(`/api/rules/${row.id}`, { method: 'PUT', headers: { cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ host: '*', filename: 'api/docs/rules-guide', content: 'bad' }) });
    expect(edit.status).toBe(400);
    const imported = await post('/api/rules/import', { mode: 'overwrite', files: [{ host: '*', filename: 'api/docs/rules-guide', content: 'bad' }] });
    expect((await imported.json()).errors).toHaveLength(1);
    expect(await (await app.request('/.well-known/test.txt')).text()).toBe('verify');
  });
  it('帮助渲染剔除事件、脚本及危险链接，保留文档格式', () => {
    const dom = new JSDOM('', { runScripts: 'outside-only' });
    try {
      dom.window.eval(readFileSync('public/vendor/marked.min.js', 'utf8'));
      dom.window.eval(readFileSync('public/vendor/purify.min.js', 'utf8'));
      const html = dom.window.marked.parse('# title\n<img src=x onerror="alert(1)"><script>alert(1)</script><a href="javascript:alert(1)">bad</a>');
      dom.window.document.body.innerHTML = dom.window.DOMPurify.sanitize(html, { USE_PROFILES: { html: true } });
      expect(dom.window.document.querySelector('h1').textContent).toBe('title');
      expect(dom.window.document.querySelector('script')).toBeNull();
      expect(dom.window.document.querySelector('img').hasAttribute('onerror')).toBe(false);
      expect(dom.window.document.querySelector('a').hasAttribute('href')).toBe(false);
    } finally { dom.window.close(); }
  });
});

it('多重双星失败匹配不会组合爆炸，正常双星语义保留', () => {
  const pattern = '**.'.repeat(60) + 'z';
  expect(normalizePattern(pattern).ok).toBe(true);
  expect(matchHost(pattern, 'a.'.repeat(60) + 'a')).toBe(false);
  expect(matchHost('**.a.**.z', 'a.z')).toBe(true);
  expect(matchHost('**.a.**.z', 'b.a.c.d.z')).toBe(true);
  expect(matchHost('*.a.z', 'a.z')).toBe(false);
});

it('匹配查询按 filename 搜索而非全索引扫描', () => {
  createFile(db, { host: '*', filename: 'verify.txt', content: 'yes', userId: 1 });
  expect(matchFile(db, 'example.com', 'verify.txt').content).toBe('yes');
  const plan = db.prepare('EXPLAIN QUERY PLAN SELECT id,host,content,priority FROM verify_files WHERE filename=? AND deleted_at IS NULL').all('verify.txt');
  expect(plan.some((r) => r.detail.includes('SEARCH') && r.detail.includes('idx_active_filename'))).toBe(true);
});

describe('备份调度', () => {
  it('跨日执行，同日去重，并发 tick 不重复备份', async () => {
    setBackupSettings(db, { enabled: true, time: '23:00', keep: 7 });
    const opts = { db, dir: join(dir, 'backups'), state: {} };
    const first = maybeRunScheduledBackup(opts, new Date(2026, 8, 9, 23));
    expect((await maybeRunScheduledBackup(opts, new Date(2026, 8, 9, 23))).ran).toBe(false);
    expect((await first).ran).toBe(true);
    expect((await maybeRunScheduledBackup(opts, new Date(2026, 8, 9, 23))).ran).toBe(false);
    expect((await maybeRunScheduledBackup(opts, new Date(2026, 8, 10, 23))).ran).toBe(true);
  });
  it.each(['false', '0', '', 'invalid', false])('env %s 不会误开启', (enabled) => {
    expect(getBackupSettings(db, { enabled }).enabled).toBe(false);
  });
  it('并发手动备份使用不同文件，不互相覆盖', async () => {
    const results = await Promise.all([runBackup(db, join(dir, 'backups'), 7), runBackup(db, join(dir, 'backups'), 7)]);
    expect(new Set(results.map((r) => r.filename)).size).toBe(2);
  });
  it('env 保留数量超上限时回落默认', () => {
    expect(getBackupSettings(db, { keep: '1001' }).keep).toBe(7);
  });
});

describe('自检出站边界', () => {
  it.each(['127.0.0.1', '10.0.0.1', '172.16.0.1', '192.168.0.1', '169.254.169.254', '0.0.0.0', '100.64.0.1', '::1', '::ffff:127.0.0.1', 'fc00::1', 'fe80::1'])('拒绝非公网地址 %s', (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });
  it('正常公网地址通过，显式白名单仅匹配目标主机', () => {
    expect(isPublicAddress('8.8.8.8')).toBe(true);
    expect(checkTarget(new URL('https://127.0.0.1'), ['127.0.0.1'])).toBe(true);
    expect(() => checkTarget(new URL('https://127.0.0.2'), ['127.0.0.1'])).toThrow();
    expect(() => checkTarget(new URL('https://user@public.example'))).toThrow();
  });
  it('DNS 返回混合公网/私网时拒绝，连接只用已校验的结果', async () => {
    const resolve = vi.fn((_host, _options, callback) => callback(null, [{ address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }]));
    const error = await new Promise((r) => safeLookup(false, resolve)('example.com', {}, (err) => r(err)));
    expect(error.code).toBe('TARGET_BLOCKED');
    expect(resolve).toHaveBeenCalledTimes(1);
    const publicResolve = vi.fn((_host, _options, callback) => callback(null, [{ address: '8.8.8.8', family: 4 }]));
    const address = await new Promise((r, reject) => safeLookup(false, publicResolve)('example.com', {}, (err, ip) => err ? reject(err) : r(ip)));
    expect(address).toBe('8.8.8.8');
    expect(publicResolve).toHaveBeenCalledTimes(1);
  });
  it('私网直连在调用网络前被阻止', async () => {
    const fetchImpl = vi.fn();
    const result = await runExternalCheck({ host: '127.0.0.1', filename: 'x.txt', content: 'x' }, { fetchImpl });
    expect(result.code).toBe('TARGET_BLOCKED');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it('响应正文失败返回检查结果，而不是抛出', async () => {
    const result = await runExternalCheck({ host: 'example.com', filename: 'x.txt', content: 'x' }, {
      fetchImpl: async () => new Response(new ReadableStream({ start(c) { c.error(Object.assign(new Error('reset'), { code: 'ECONNRESET' })); } }), { headers: { 'Content-Type': 'text/plain' } }),
    });
    expect(result.code).toBe('EGRESS_BLOCKED');
  });
  it('响应长度限制覆盖无 Content-Length 的流式数据', async () => {
    const cancel = vi.fn();
    const result = await runExternalCheck({ host: 'example.com', filename: 'x.txt', content: 'x' }, {
      fetchImpl: async () => new Response(new ReadableStream({ pull(c) { c.enqueue(new Uint8Array(65537)); }, cancel }), { headers: { 'Content-Type': 'text/plain' } }),
    });
    expect(result.code).toBe('RESPONSE_TOO_LARGE');
    expect(cancel).toHaveBeenCalled();
  });
  it('BOM 不会被解码器丢弃而产生错误的通过结果', async () => {
    const result = await runExternalCheck({ host: 'example.com', filename: 'x.txt', content: 'x' }, {
      fetchImpl: async () => new Response('\ufeffx', { headers: { 'Content-Type': 'text/plain' } }),
    });
    expect(result.code).toBe('CONTENT_MISMATCH');
    expect(result.actual).toBe('\ufeffx');
  });
  it('批量任务中一条断流不会阻止剩余记录完成', async () => {
    const rows = [1, 2].map((i) => createFile(db, { host: 'example.com', filename: `${i}.txt`, content: 'x', userId: 1 }));
    const id = createBatchCheck({ db, rows, fetchImpl: async (url) => ({ status: 200, headers: new Headers({ 'Content-Type': 'text/plain' }), text: async () => { if (url.includes('/1.txt')) throw new Error('reset'); return 'x'; } }) });
    await vi.waitFor(() => expect(getBatchCheck(id).status).toBe('done'));
    expect(getBatchCheck(id).done).toBe(2);
    expect(getBatchCheck(id).results.some((r) => r.external.code === 'OK')).toBe(true);
    _test.tasks.delete(id);
  });
});

describe('登录保护', () => {
  it('账号限流恢复，并发计数释放，不依赖转发头', () => {
    let time = 0;
    const limiter = createLoginLimiter({ now: () => time, perAccount: 2, total: 3, concurrent: 1 });
    const release = limiter.acquire('a');
    expect(limiter.acquire('b')).toBeNull();
    release(); release();
    limiter.acquire('a')();
    expect(limiter.acquire('a')).toBeNull();
    limiter.acquire('b')();
    expect(limiter.acquire('c')).toBeNull();
    time = 60001;
    expect(limiter.acquire('a')).toBeTypeOf('function');
  });
  it('连续失败后返回 429，改 XFF 不能绕过', async () => {
    for (let i = 0; i < 10; i++) expect((await post('/api/auth/login', { username: 'ordinary', password: 'wrong' })).status).toBe(401);
    const res = await app.request('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '8.8.8.8' }, body: JSON.stringify({ username: 'ordinary', password: 'test-password' }) });
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('60');
  });
  it('异步密码校验兼容旧哈希，并拒绝超长密码', async () => {
    const hash = hashPassword('test-password');
    expect(await verifyPasswordAsync('test-password', hash)).toBe(true);
    expect(await verifyPasswordAsync('wrong', hash)).toBe(false);
    expect(await verifyPasswordAsync('x'.repeat(1025), hash)).toBe(false);
    expect(await verifyPasswordAsync('test-password', 'bad')).toBe(false);
  });
});
