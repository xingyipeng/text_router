import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db.js';
import { createFile, getFile, softDeleteFile } from '../src/repo/rules.js';
import { runInternalCheck, runExternalCheck, CHECK_CODES } from '../src/selfcheck.js';

let dir, db;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wxr-'));
  db = openDb(join(dir, 'test.db'));
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const okResponse = (body, contentType = 'text/plain; charset=utf-8') => ({
  status: 200,
  headers: { get: (k) => (k.toLowerCase() === 'content-type' ? contentType : null) },
  text: async () => body,
});

describe('runInternalCheck', () => {
  it('正常记录通过', () => {
    const f = createFile(db, { host: 'a.com', filename: 'x.txt', content: 'v', userId: 1 });
    expect(runInternalCheck(db, getFile(db, f.id)).ok).toBe(true);
  });

  it('已删除记录不通过', () => {
    const f = createFile(db, { host: 'a.com', filename: 'x.txt', content: 'v', userId: 1 });
    softDeleteFile(db, f.id, 1);
    const r = runInternalCheck(db, getFile(db, f.id));
    expect(r.ok).toBe(false);
    expect(r.problems.join()).toContain('已被删除');
  });

  it('内容为空不通过', () => {
    const f = createFile(db, { host: 'a.com', filename: 'x.txt', content: '', userId: 1 });
    expect(runInternalCheck(db, getFile(db, f.id)).ok).toBe(false);
  });

  it('被更精确的记录遮蔽时不通过', () => {
    const global = createFile(db, { host: '', filename: 'x.txt', content: 'g', userId: 1 });
    createFile(db, { host: 'a.com', filename: 'x.txt', content: 'e', userId: 1 });
    const r = runInternalCheck(db, getFile(db, global.id), 'a.com');
    expect(r.ok).toBe(false);
    expect(r.problems.join()).toContain('命中的不是这条');
  });

  it('全局记录被遮蔽时（不传 probeHost）也不通过，并指明域名与遮蔽者 id', () => {
    const global = createFile(db, { host: '', filename: 'x.txt', content: 'g', userId: 1 });
    const exact = createFile(db, { host: 'a.com', filename: 'x.txt', content: 'e', userId: 1 });
    const r = runInternalCheck(db, getFile(db, global.id));
    expect(r.ok).toBe(false);
    expect(r.problems.join()).toContain('a.com');
    expect(r.problems.join()).toContain(`id=${exact.id}`);
  });

  it('全局记录无遮蔽时（不传 probeHost）通过', () => {
    const global = createFile(db, { host: '', filename: 'x.txt', content: 'g', userId: 1 });
    expect(runInternalCheck(db, getFile(db, global.id)).ok).toBe(true);
  });

  it('记录不存在时不通过', () => {
    expect(runInternalCheck(db, undefined).ok).toBe(false);
  });
});

describe('runExternalCheck', () => {
  const file = { host: 'a.com', filename: 'x.txt', content: 'abc123' };

  it('全部匹配返回 OK', async () => {
    const r = await runExternalCheck(file, { fetchImpl: async () => okResponse('abc123') });
    expect(r.code).toBe(CHECK_CODES.OK);
  });

  it('请求的是 https 根路径 URL', async () => {
    let seen;
    await runExternalCheck(file, {
      fetchImpl: async (url) => { seen = url; return okResponse('abc123'); },
    });
    expect(seen).toBe('https://a.com/x.txt');
  });

  it('用 redirect: manual 以便捕获跳转', async () => {
    let seenInit;
    await runExternalCheck(file, {
      fetchImpl: async (_u, init) => { seenInit = init; return okResponse('abc123'); },
    });
    expect(seenInit.redirect).toBe('manual');
  });

  it('host 为空时返回 NO_HOST 且不发请求', async () => {
    let called = false;
    const r = await runExternalCheck({ ...file, host: '' }, {
      fetchImpl: async () => { called = true; return okResponse('abc123'); },
    });
    expect(r.code).toBe(CHECK_CODES.NO_HOST);
    expect(called).toBe(false);
  });

  it('3xx 返回 REDIRECTED 并带跳转目标', async () => {
    const r = await runExternalCheck(file, {
      fetchImpl: async () => ({
        status: 301,
        headers: { get: (k) => (k.toLowerCase() === 'location' ? 'https://b.com/x.txt' : null) },
        text: async () => '',
      }),
    });
    expect(r.code).toBe(CHECK_CODES.REDIRECTED);
    expect(r.detail).toContain('https://b.com/x.txt');
  });

  it('非 200 返回 STATUS_NOT_200 并带状态码', async () => {
    const r = await runExternalCheck(file, {
      fetchImpl: async () => ({
        status: 404, headers: { get: () => null }, text: async () => '',
      }),
    });
    expect(r.code).toBe(CHECK_CODES.STATUS_NOT_200);
    expect(r.detail).toContain('404');
  });

  it('Content-Type 不对返回 CONTENT_TYPE_WRONG', async () => {
    const r = await runExternalCheck(file, {
      fetchImpl: async () => okResponse('abc123', 'text/html'),
    });
    expect(r.code).toBe(CHECK_CODES.CONTENT_TYPE_WRONG);
    expect(r.detail).toContain('text/html');
  });

  it('内容不一致返回 CONTENT_MISMATCH 并带双方内容', async () => {
    const r = await runExternalCheck(file, {
      fetchImpl: async () => okResponse('wrong'),
    });
    expect(r.code).toBe(CHECK_CODES.CONTENT_MISMATCH);
    expect(r.expected).toBe('abc123');
    expect(r.actual).toBe('wrong');
  });

  it('尾部多一个换行也算不一致', async () => {
    const r = await runExternalCheck(file, {
      fetchImpl: async () => okResponse('abc123\n'),
    });
    expect(r.code).toBe(CHECK_CODES.CONTENT_MISMATCH);
  });

  it('DNS 失败归类为 DNS_OR_CONNECT_FAILED', async () => {
    const r = await runExternalCheck(file, {
      fetchImpl: async () => {
        const err = new TypeError('fetch failed');
        err.cause = { code: 'ENOTFOUND' };
        throw err;
      },
    });
    expect(r.code).toBe(CHECK_CODES.DNS_OR_CONNECT_FAILED);
  });

  it('连接被拒归类为 EGRESS_BLOCKED', async () => {
    const r = await runExternalCheck(file, {
      fetchImpl: async () => {
        const err = new TypeError('fetch failed');
        err.cause = { code: 'ECONNREFUSED' };
        throw err;
      },
    });
    expect(r.code).toBe(CHECK_CODES.EGRESS_BLOCKED);
  });

  it('失败时保留原始错误信息', async () => {
    const r = await runExternalCheck(file, {
      fetchImpl: async () => {
        const err = new TypeError('fetch failed');
        err.cause = { code: 'ENOTFOUND' };
        throw err;
      },
    });
    expect(r.detail).toContain('ENOTFOUND');
  });
});
