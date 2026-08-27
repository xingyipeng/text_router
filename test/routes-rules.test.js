import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db.js';
import { createUser, disableUser } from '../src/repo/users.js';
import { createRequestLog } from '../src/requestlog.js';
import { createApp } from '../src/app.js';

let dir, db, app, cookie;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'wxr-'));
  db = openDb(join(dir, 'test.db'));
  app = createApp({
    db,
    requestLog: createRequestLog(),
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
    expect((await anon('/api/rules')).status).toBe(401);
    expect((await anon('/api/rules', 'POST', {})).status).toBe(401);
    expect((await anon('/api/rules/1', 'DELETE')).status).toBe(401);
  });
});

describe('POST /api/rules', () => {
  it('创建成功返回 201 与记录', async () => {
    const res = await api('/api/rules', 'POST',
      { host: 'a.com', filename: 'MP_verify_abc.txt', content: 'abc123', note: '公众号甲' });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.filename).toBe('MP_verify_abc.txt');
    expect(body.created_by_username).toBe('alice');
  });

  it('host 被规范化', async () => {
    const res = await api('/api/rules', 'POST',
      { host: 'A.COM:8080', filename: 'x.txt', content: 'v' });
    expect((await res.json()).host).toBe('a.com');
  });

  it('非法文件名返回 400', async () => {
    for (const filename of ['../x.txt', 'x.php', '', 'x.txt.php', '/x.txt', 'a//b.txt']) {
      const res = await api('/api/rules', 'POST', { host: 'a.com', filename, content: 'v' });
      expect(res.status, filename).toBe(400);
    }
  });

  it('子目录路径合法，创建成功', async () => {
    const res = await api('/api/rules', 'POST',
      { host: 'a.com', filename: 'h5/MP_verify_1.txt', content: 'v' });
    expect(res.status).toBe(201);
    expect((await res.json()).filename).toBe('h5/MP_verify_1.txt');
  });

  it('总长超过 255 返回 400', async () => {
    const long = ['a'.repeat(80), 'b'.repeat(80), 'c'.repeat(80), 'd'.repeat(80)].join('/') + '.txt';
    const res = await api('/api/rules', 'POST', { host: 'a.com', filename: long, content: 'v' });
    expect(res.status).toBe(400);
  });

  it('文件名长度边界：80 字符通过，81 字符 400', async () => {
    expect((await api('/api/rules', 'POST',
      { host: 'a.com', filename: `${'a'.repeat(80)}.txt`, content: 'v' })).status).toBe(201);
    expect((await api('/api/rules', 'POST',
      { host: 'a.com', filename: `${'b'.repeat(81)}.txt`, content: 'v' })).status).toBe(400);
  });

  it('最短文件名与大小写/数字/下划线/连字符混合均合法', async () => {
    expect((await api('/api/rules', 'POST',
      { host: 'a.com', filename: 'a.txt', content: 'v' })).status).toBe(201);
    expect((await api('/api/rules', 'POST',
      { host: 'a.com', filename: 'MP_verify_ABC-123_.txt', content: 'v' })).status).toBe(201);
  });

  it('内容超过 4KB 返回 400', async () => {
    const res = await api('/api/rules', 'POST',
      { host: 'a.com', filename: 'x.txt', content: 'a'.repeat(4097) });
    expect(res.status).toBe(400);
  });

  it('内容按字节计数：4096 字节通过，多字节字符按 UTF-8 字节算', async () => {
    expect((await api('/api/rules', 'POST',
      { host: 'a.com', filename: 'x.txt', content: 'a'.repeat(4096) })).status).toBe(201);
    expect((await api('/api/rules', 'POST',
      { host: 'a.com', filename: 'y.txt', content: '中'.repeat(1365) })).status).toBe(201); // 4095 字节
    expect((await api('/api/rules', 'POST',
      { host: 'a.com', filename: 'z.txt', content: '中'.repeat(1366) })).status).toBe(400); // 4098 字节
  });

  it('空内容允许创建，由自检把关', async () => {
    const res = await api('/api/rules', 'POST', { host: 'a.com', filename: 'x.txt', content: '' });
    expect(res.status).toBe(201);
    expect((await res.json()).content).toBe('');
  });

  it('内容非字符串返回 400', async () => {
    expect((await api('/api/rules', 'POST',
      { host: 'a.com', filename: 'x.txt', content: 123 })).status).toBe(400);
  });

  it('重复的 host+filename 返回 409', async () => {
    await api('/api/rules', 'POST', { host: 'a.com', filename: 'x.txt', content: 'v1' });
    const res = await api('/api/rules', 'POST', { host: 'a.com', filename: 'x.txt', content: 'v2' });
    expect(res.status).toBe(409);
  });

  it('内容原样保存，不做 trim', async () => {
    const res = await api('/api/rules', 'POST',
      { host: 'a.com', filename: 'x.txt', content: '  spaced  \n' });
    expect((await res.json()).content).toBe('  spaced  \n');
  });

  it('返回内容体检结果', async () => {
    const res = await api('/api/rules', 'POST',
      { host: 'a.com', filename: 'x.txt', content: ' v\r\n' });
    const body = await res.json();
    expect(body.inspect.hasCrlf).toBe(true);
    expect(body.inspect.hasLeadingWhitespace).toBe(true);
  });

  it('空 host 保存为全局 *', async () => {
    const res = await api('/api/rules', 'POST', { host: '', filename: 'g.txt', content: 'v' });
    expect((await res.json()).host).toBe('*');
  });

  it('合法模式与优先级创建成功', async () => {
    const res = await api('/api/rules', 'POST',
      { host: '*.example.com', filename: 'x.txt', content: 'v', priority: 500 });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.host).toBe('*.example.com');
    expect(body.priority).toBe(500);
  });

  it('非法模式返回 400', async () => {
    for (const host of ['a*.example.com', '***.x.com', '*.example.com:8080']) {
      const res = await api('/api/rules', 'POST', { host, filename: 'x.txt', content: 'v' });
      expect(res.status, host).toBe(400);
    }
  });

  it('单独 ** 归一化为全局 *', async () => {
    const res = await api('/api/rules', 'POST', { host: '**', filename: 'x.txt', content: 'v' });
    expect((await res.json()).host).toBe('*');
  });

  it('priority 非法返回 400', async () => {
    for (const priority of [-1, 1001, 1.5, '5']) {
      const res = await api('/api/rules', 'POST',
        { host: 'a.com', filename: `p${String(priority)}.txt`, content: 'v', priority });
      expect(res.status, String(priority)).toBe(400);
    }
  });
});

describe('GET /api/rules', () => {
  beforeEach(async () => {
    await api('/api/rules', 'POST', { host: 'a.com', filename: 'one.txt', content: 'v', note: '甲' });
    await api('/api/rules', 'POST', { host: 'b.com', filename: 'two.txt', content: 'v', note: '乙' });
  });

  it('返回全部未删除记录', async () => {
    expect(await (await api('/api/rules')).json()).toHaveLength(2);
  });

  it('按 host 过滤', async () => {
    expect(await (await api('/api/rules?host=a.com')).json()).toHaveLength(1);
  });

  it('按 host 过滤时包含全局记录', async () => {
    await api('/api/rules', 'POST', { host: '*', filename: 'g.txt', content: 'v' });
    const rows = await (await api('/api/rules?host=a.com')).json();
    expect(rows.map((r) => r.filename).sort()).toEqual(['g.txt', 'one.txt']);
  });

  it('only_global=1 只返回全局记录', async () => {
    await api('/api/rules', 'POST', { host: '*', filename: 'g.txt', content: 'v' });
    const rows = await (await api('/api/rules?only_global=1')).json();
    expect(rows.map((r) => r.filename)).toEqual(['g.txt']);
  });

  it('按 q 搜索', async () => {
    expect(await (await api('/api/rules?q=one')).json()).toHaveLength(1);
    expect(await (await api('/api/rules?q=乙')).json()).toHaveLength(1);
  });

  it('不返回 password_hash 之类的敏感字段', async () => {
    const rows = await (await api('/api/rules')).json();
    expect(JSON.stringify(rows)).not.toContain('password');
  });
});

describe('GET /api/rules 排序', () => {
  beforeEach(async () => {
    // alice 建 b、a 两条，bob 建 c 一条；再把时间字段固定为确定值，避免同毫秒抖动
    await api('/api/rules', 'POST', { host: 'b.com', filename: 'b-file.txt', content: 'v' });
    await api('/api/rules', 'POST', { host: 'a.com', filename: 'a-file.txt', content: 'v' });
    createUser(db, { username: 'bob', password: 'password1234' });
    const res = await app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', host: 'admin.local' },
      body: JSON.stringify({ username: 'bob', password: 'password1234' }),
    });
    const bobCookie = (res.headers.get('set-cookie') || '').split(';')[0];
    await app.request('/api/rules', {
      method: 'POST',
      headers: { 'content-type': 'application/json', host: 'admin.local', cookie: bobCookie },
      body: JSON.stringify({ host: 'c.com', filename: 'c-file.txt', content: 'v' }),
    });
    db.prepare("UPDATE verify_files SET updated_at = 1000, created_at = 1000 WHERE filename = 'b-file.txt'").run();
    db.prepare("UPDATE verify_files SET updated_at = 2000, created_at = 2000 WHERE filename = 'a-file.txt'").run();
    db.prepare("UPDATE verify_files SET updated_at = 3000, created_at = 3000 WHERE filename = 'c-file.txt'").run();
  });

  it('默认按最后修改降序', async () => {
    const rows = await (await api('/api/rules')).json();
    expect(rows.map((r) => r.filename)).toEqual(['c-file.txt', 'a-file.txt', 'b-file.txt']);
  });

  it('sort=updated&dir=asc 升序', async () => {
    const rows = await (await api('/api/rules?sort=updated&dir=asc')).json();
    expect(rows.map((r) => r.filename)).toEqual(['b-file.txt', 'a-file.txt', 'c-file.txt']);
  });

  it('sort=host 默认升序，dir=desc 降序', async () => {
    const asc = await (await api('/api/rules?sort=host')).json();
    expect(asc.map((r) => r.host)).toEqual(['a.com', 'b.com', 'c.com']);
    const desc = await (await api('/api/rules?sort=host&dir=desc')).json();
    expect(desc.map((r) => r.host)).toEqual(['c.com', 'b.com', 'a.com']);
  });

  it('sort=filename 升降序', async () => {
    const asc = await (await api('/api/rules?sort=filename&dir=asc')).json();
    expect(asc.map((r) => r.filename)).toEqual(['a-file.txt', 'b-file.txt', 'c-file.txt']);
    const desc = await (await api('/api/rules?sort=filename&dir=desc')).json();
    expect(desc.map((r) => r.filename)).toEqual(['c-file.txt', 'b-file.txt', 'a-file.txt']);
  });

  it('sort=created_by 按创建人用户名排序', async () => {
    const asc = await (await api('/api/rules?sort=created_by&dir=asc')).json();
    expect(asc.map((r) => r.created_by_username)).toEqual(['alice', 'alice', 'bob']);
    const desc = await (await api('/api/rules?sort=created_by&dir=desc')).json();
    expect(desc.map((r) => r.created_by_username)).toEqual(['bob', 'alice', 'alice']);
  });

  it('sort=created 默认降序，dir=asc 升序', async () => {
    const desc = await (await api('/api/rules?sort=created')).json();
    expect(desc.map((r) => r.filename)).toEqual(['c-file.txt', 'a-file.txt', 'b-file.txt']);
    const asc = await (await api('/api/rules?sort=created&dir=asc')).json();
    expect(asc.map((r) => r.filename)).toEqual(['b-file.txt', 'a-file.txt', 'c-file.txt']);
  });

  it('非法 sort/dir 回退默认（按最后修改降序）', async () => {
    const rows = await (await api('/api/rules?sort=hack&dir=sideways')).json();
    expect(rows.map((r) => r.filename)).toEqual(['c-file.txt', 'a-file.txt', 'b-file.txt']);
  });
});

describe('GET /api/rules/meta', () => {
  it('未登录 401', async () => {
    expect((await anon('/api/rules/meta')).status).toBe(401);
  });

  it('hosts 为活跃记录的去重域名（不含全局记录的空域名）', async () => {
    await api('/api/rules', 'POST', { host: 'b.com', filename: 'b.txt', content: 'v' });
    await api('/api/rules', 'POST', { host: 'a.com', filename: 'a.txt', content: 'v' });
    await api('/api/rules', 'POST', { host: '*', filename: 'g.txt', content: 'v' });
    const body = await (await api('/api/rules/meta')).json();
    expect(body.hosts).toEqual(['a.com', 'b.com']);
  });

  it('已删除文件的作者仍出现在操作人里，域名随之消失', async () => {
    const f = await (await api('/api/rules', 'POST',
      { host: 'a.com', filename: 'x.txt', content: 'v' })).json();
    await api(`/api/rules/${f.id}`, 'DELETE');
    const body = await (await api('/api/rules/meta')).json();
    expect(body.persons.map((p) => p.username)).toEqual(['alice']);
    expect(body.hosts).toEqual([]);
  });

  it('persons 只含状态正常的用户（禁用的不出现）', async () => {
    const bob = createUser(db, { username: 'bob', password: 'password1234' });
    disableUser(db, bob.id);
    const body = await (await api('/api/rules/meta')).json();
    expect(body.persons.map((p) => p.username)).toEqual(['alice']);
  });
});

describe('PUT /api/rules/:id', () => {
  it('修改内容并更新 updated_by', async () => {
    const created = await (await api('/api/rules', 'POST',
      { host: 'a.com', filename: 'x.txt', content: 'v1' })).json();
    const res = await api(`/api/rules/${created.id}`, 'PUT',
      { host: 'a.com', filename: 'x.txt', content: 'v2', note: '改了' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.content).toBe('v2');
    expect(body.updated_by_username).toBe('alice');
  });

  it('改成与另一条冲突的 host+filename 返回 409', async () => {
    await api('/api/rules', 'POST', { host: 'a.com', filename: 'x.txt', content: 'v' });
    const b = await (await api('/api/rules', 'POST',
      { host: 'a.com', filename: 'y.txt', content: 'v' })).json();
    expect((await api(`/api/rules/${b.id}`, 'PUT',
      { host: 'a.com', filename: 'x.txt', content: 'v' })).status).toBe(409);
  });

  it('不存在的 id 返回 404', async () => {
    expect((await api('/api/rules/9999', 'PUT',
      { host: 'a.com', filename: 'x.txt', content: 'v' })).status).toBe(404);
  });
});

describe('DELETE 与 restore', () => {
  it('删除是软删除，回收站可见', async () => {
    const f = await (await api('/api/rules', 'POST',
      { host: 'a.com', filename: 'x.txt', content: 'v' })).json();
    expect((await api(`/api/rules/${f.id}`, 'DELETE')).status).toBe(204);
    expect(await (await api('/api/rules')).json()).toHaveLength(0);
    const deleted = await (await api('/api/rules?include_deleted=1')).json();
    expect(deleted).toHaveLength(1);
    expect(deleted[0].deleted_by_username).toBe('alice');
  });

  it('恢复后重新出现在列表里', async () => {
    const f = await (await api('/api/rules', 'POST',
      { host: 'a.com', filename: 'x.txt', content: 'v' })).json();
    await api(`/api/rules/${f.id}`, 'DELETE');
    expect((await api(`/api/rules/${f.id}/restore`, 'POST')).status).toBe(200);
    expect(await (await api('/api/rules')).json()).toHaveLength(1);
  });

  it('恢复时同名启用记录已存在返回 409', async () => {
    const f = await (await api('/api/rules', 'POST',
      { host: 'a.com', filename: 'x.txt', content: 'v1' })).json();
    await api(`/api/rules/${f.id}`, 'DELETE');
    await api('/api/rules', 'POST', { host: 'a.com', filename: 'x.txt', content: 'v2' });
    expect((await api(`/api/rules/${f.id}/restore`, 'POST')).status).toBe(409);
  });
});

describe('POST /api/rules/:id/check', () => {
  it('返回内部与外部两层结果', async () => {
    const f = await (await api('/api/rules', 'POST',
      { host: '*', filename: 'x.txt', content: 'v' })).json();
    const res = await api(`/api/rules/${f.id}/check`, 'POST');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.internal.ok).toBe(true);
    expect(body.external.code).toBe('NO_HOST');
  });

  it('不存在的 id 返回 404', async () => {
    expect((await api('/api/rules/9999/check', 'POST')).status).toBe(404);
  });

  it('全局记录被精确记录遮蔽时内部检查不通过', async () => {
    const g = await (await api('/api/rules', 'POST',
      { host: '*', filename: 'x.txt', content: 'g' })).json();
    await api('/api/rules', 'POST', { host: 'a.com', filename: 'x.txt', content: 'e' });
    const body = await (await api(`/api/rules/${g.id}/check`, 'POST')).json();
    expect(body.internal.ok).toBe(false);
    expect(body.internal.problems.join()).toContain('a.com');
  });
});

describe('GET /api/rules/export', () => {
  it('导出 JSON：版本/数量/记录齐全，只含未删除记录', async () => {
    await api('/api/rules', 'POST', { host: 'a.com', filename: 'a.txt', content: 'va', note: '甲' });
    await api('/api/rules', 'POST', { host: '*', filename: 'g.txt', content: 'vg', note: '', priority: 0 });
    const del = await (await api('/api/rules', 'POST',
      { host: 'b.com', filename: 'b.txt', content: 'vb' })).json();
    await api(`/api/rules/${del.id}`, 'DELETE');

    const res = await api('/api/rules/export');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition'))
      .toMatch(/^attachment; filename="text_router-rules-\d{14}\.json"$/);
    const body = await res.json();
    expect(body.version).toBe(1);
    expect(body.exported_at).toBeTruthy();
    expect(body.count).toBe(2);
    expect(body.files).toEqual(expect.arrayContaining([
      { host: 'a.com', filename: 'a.txt', content: 'va', note: '甲', priority: 0 },
      { host: '*', filename: 'g.txt', content: 'vg', note: '', priority: 0 },
    ]));
  });

  it('未登录 401', async () => {
    expect((await anon('/api/rules/export')).status).toBe(401);
  });
});

describe('POST /api/rules/import', () => {
  it('mode=skip：新记录导入、冲突跳过并计数', async () => {
    await api('/api/rules', 'POST', { host: 'a.com', filename: 'a.txt', content: 'old' });
    const res = await api('/api/rules/import', 'POST', {
      mode: 'skip',
      files: [
        { host: 'a.com', filename: 'a.txt', content: 'new', note: '' },
        { host: 'b.com', filename: 'b.txt', content: 'vb', note: '' },
      ],
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ imported: 1, skipped: 1, errors: [] });

    const rowsA = await (await api('/api/rules?host=a.com')).json();
    expect(rowsA.find((r) => r.filename === 'a.txt').content).toBe('old'); // 未被覆盖
    const rowsB = await (await api('/api/rules?host=b.com')).json();
    expect(rowsB.find((r) => r.filename === 'b.txt').content).toBe('vb');
  });

  it('mode=overwrite：冲突记录被覆盖（内容/备注/修改人更新）', async () => {
    const created = await (await api('/api/rules', 'POST',
      { host: 'a.com', filename: 'a.txt', content: 'old', note: '旧备注' })).json();
    const res = await api('/api/rules/import', 'POST', {
      mode: 'overwrite',
      files: [{ host: 'a.com', filename: 'a.txt', content: 'new', note: '新备注' }],
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ imported: 1, skipped: 0, errors: [] });

    const rows = await (await api('/api/rules')).json();
    const a = rows.find((r) => r.id === created.id);
    expect(a.content).toBe('new');
    expect(a.note).toBe('新备注');
    expect(a.updated_by_username).toBe('alice');
  });

  it('校验失败的记录进 errors（含 host/filename/reason），其余正常导入', async () => {
    const res = await api('/api/rules/import', 'POST', {
      mode: 'skip',
      files: [
        { host: 'a.com', filename: 'bad.php', content: 'x' }, // 非法文件名
        { host: 'a.com', filename: 'ok.txt', content: 'ok' },
        { filename: 'no-content.txt' }, // 缺 content
      ],
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.imported).toBe(1);
    expect(body.skipped).toBe(0);
    expect(body.errors).toHaveLength(2);
    expect(body.errors[0]).toMatchObject({
      host: 'a.com', filename: 'bad.php', reason: expect.stringContaining('路径'),
    });
    expect(body.errors[1].reason).toContain('内容');

    const rows = await (await api('/api/rules?host=a.com')).json();
    expect(rows.find((r) => r.filename === 'ok.txt')).toBeTruthy();
  });

  it('同一批内重复 key：先创建后命中，按策略处理不报错', async () => {
    const res = await api('/api/rules/import', 'POST', {
      mode: 'overwrite',
      files: [
        { host: 'a.com', filename: 'dup.txt', content: 'first' },
        { host: 'a.com', filename: 'dup.txt', content: 'second' },
      ],
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ imported: 2, skipped: 0, errors: [] });
    const rows = await (await api('/api/rules?host=a.com')).json();
    const dups = rows.filter((r) => r.filename === 'dup.txt');
    expect(dups).toHaveLength(1);
    expect(dups[0].content).toBe('second');
  });

  it('超 5000 条 400', async () => {
    const files = Array.from({ length: 5001 }, (_, i) => ({
      host: 'a.com', filename: `f${i}.txt`, content: 'v',
    }));
    const res = await api('/api/rules/import', 'POST', { mode: 'skip', files });
    expect(res.status).toBe(400);
  });

  it('坏 mode / files 非数组或空 → 400', async () => {
    expect((await api('/api/rules/import', 'POST', { mode: 'merge', files: [] })).status).toBe(400);
    expect((await api('/api/rules/import', 'POST', { mode: 'skip', files: 'x' })).status).toBe(400);
    expect((await api('/api/rules/import', 'POST', { mode: 'skip', files: [] })).status).toBe(400);
  });

  it('未登录 401', async () => {
    expect((await anon('/api/rules/import', 'POST', { mode: 'skip', files: [] })).status).toBe(401);
  });

  it('旧格式（无 priority）默认 0，新格式写入 priority', async () => {
    const res = await api('/api/rules/import', 'POST', {
      mode: 'skip',
      files: [
        { host: 'a.com', filename: 'old.txt', content: 'o' },           // 旧格式
        { host: 'b.com', filename: 'new.txt', content: 'n', priority: 9 }, // 新格式
      ],
    });
    expect(res.status).toBe(200);
    const rows = await (await api('/api/rules')).json();
    expect(rows.find((r) => r.filename === 'old.txt').priority).toBe(0);
    expect(rows.find((r) => r.filename === 'new.txt').priority).toBe(9);
  });

  it('非法模式进 errors，不影响其余导入', async () => {
    const res = await api('/api/rules/import', 'POST', {
      mode: 'skip',
      files: [
        { host: 'a*.example.com', filename: 'bad.txt', content: 'x' },
        { host: 'a.com', filename: 'ok.txt', content: 'ok' },
      ],
    });
    const body = await res.json();
    expect(body.imported).toBe(1);
    expect(body.errors).toHaveLength(1);
    expect(body.errors[0].reason).toContain('域名模式');
  });
});
