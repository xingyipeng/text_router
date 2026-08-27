// test/batchcheck.test.js
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db.js';
import { createFile, listFiles } from '../src/repo/rules.js';
import { createBatchCheck, getBatchCheck, _test } from '../src/batchcheck.js';

let dir, db;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wxr-'));
  db = openDb(join(dir, 'test.db'));
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const okResponse = (body = 'v') => ({
  status: 200,
  headers: { get: (k) => (k.toLowerCase() === 'content-type' ? 'text/plain; charset=utf-8' : null) },
  text: async () => body,
});

async function waitDone(id) {
  for (let i = 0; i < 200; i++) {
    const job = getBatchCheck(id);
    if (job.status === 'done') return job;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('任务超时未完成');
}

function seedRows(n) {
  for (let i = 1; i <= n; i++) {
    createFile(db, { host: 'a.com', filename: `f${i}.txt`, content: 'v', userId: 1 });
  }
  return listFiles(db, {});
}

describe('createBatchCheck', () => {
  it('创建后 running，完成后 done 且结果齐全', async () => {
    const rows = seedRows(3);
    const id = createBatchCheck({ db, fetchImpl: async () => okResponse('v'), rows });
    expect(getBatchCheck(id).status).toBe('running');

    const job = await waitDone(id);
    expect(job.total).toBe(3);
    expect(job.done).toBe(3);
    expect(job.results).toHaveLength(3);
    const ids = job.results.map((r) => r.id).sort();
    expect(ids).toEqual(rows.map((r) => r.id).sort());
    expect(job.results.every((r) => r.external.code === 'OK')).toBe(true);
    expect(job.results.every((r) => typeof r.internal.ok === 'boolean')).toBe(true);
  });

  it('外部检查复用 fetchImpl', async () => {
    const rows = seedRows(2);
    let calls = 0;
    const id = createBatchCheck({
      db, rows,
      fetchImpl: async () => { calls++; return okResponse('v'); },
    });
    await waitDone(id);
    expect(calls).toBe(2);
  });

  it('不存在的 id 返回 undefined', () => {
    expect(getBatchCheck('nope')).toBeUndefined();
  });

  it('并发上限 5', async () => {
    const rows = seedRows(12);
    let active = 0;
    let maxActive = 0;
    const id = createBatchCheck({
      db, rows,
      fetchImpl: async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 10));
        active--;
        return okResponse('v');
      },
    });
    const job = await waitDone(id);
    expect(job.done).toBe(12);
    expect(maxActive).toBeLessThanOrEqual(5);
    expect(maxActive).toBeGreaterThan(1);
  });

  it('过期任务在创建新任务时被清理', async () => {
    _test.tasks.set('old', { id: 'old', createdAt: Date.now() - _test.TTL_MS - 1000, total: 1, done: 1, status: 'done', results: new Map() });
    seedRows(1);
    const rows = listFiles(db, {});
    createBatchCheck({ db, rows, fetchImpl: async () => okResponse('v') });
    expect(_test.tasks.has('old')).toBe(false);
  });
});
