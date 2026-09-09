// src/batchcheck.js
// 批量自检异步任务：内存注册表（模块级 Map，单进程共享），
// 创建后并发 5 逐行执行内部 + 外部检查，完成后保留 10 分钟，读写注册表时清理过期任务；不持久化。

import { randomUUID } from 'node:crypto';
import { runInternalCheck, runExternalCheck } from './selfcheck.js';
import { getSettings } from './settings.js';

const TTL_MS = 10 * 60 * 1000;
const CONCURRENCY = 5;

const tasks = new Map();

function prune() {
  const now = Date.now();
  for (const [id, t] of tasks) {
    if (t.status !== 'running' && now - (t.finishedAt ?? t.createdAt) > TTL_MS) tasks.delete(id);
  }
}

export function createBatchCheck({ db, fetchImpl, rows, defaults, allowedHosts }) {
  prune();
  if ([...tasks.values()].filter((t) => t.status === 'running').length >= 4 || tasks.size >= 32) return undefined;
  const id = randomUUID();
  const task = {
    id,
    createdAt: Date.now(),
    total: rows.length,
    done: 0,
    status: 'running',
    results: new Map(), // rowId -> { internal, external }
  };
  tasks.set(id, task);
  runBatch(db, fetchImpl, task, rows, defaults, allowedHosts).catch(() => {
    task.status = 'failed';
    task.finishedAt = Date.now();
  });
  return id;
}

async function runBatch(db, fetchImpl, task, rows, defaults, allowedHosts) {
  const timeoutMs = getSettings(db, defaults).selfcheck.timeout_seconds * 1000;
  const queue = [...rows];
  const worker = async () => {
    while (queue.length) {
      const file = queue.shift();
      if (!file) return;
      try {
        const internal = runInternalCheck(db, file);
        const external = await runExternalCheck(file, {
          ...(fetchImpl ? { fetchImpl } : {}), timeoutMs, allowedHosts,
        });
        task.results.set(file.id, { internal, external });
      } catch (err) {
        task.results.set(file.id, {
          internal: { ok: false, problems: [err.message || '自检失败'] },
          external: { code: 'CHECK_FAILED', detail: '检查失败，请重试' },
        });
      }
      task.done++;
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  task.status = 'done';
  task.finishedAt = Date.now();
}

export function getBatchCheck(id) {
  prune();
  const t = tasks.get(id);
  if (!t) return undefined;
  return {
    id: t.id,
    status: t.status,
    total: t.total,
    done: t.done,
    results: [...t.results.entries()].map(([rid, r]) => ({ id: rid, ...r })),
  };
}

// 测试用：暴露注册表与常量
export const _test = { tasks, TTL_MS };
