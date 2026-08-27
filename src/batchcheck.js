// src/batchcheck.js
// 批量自检异步任务：内存注册表（模块级 Map，单进程共享），
// 创建后并发 5 逐行执行内部 + 外部检查，10 分钟后自动清除；不持久化。

import { randomUUID } from 'node:crypto';
import { runInternalCheck, runExternalCheck } from './selfcheck.js';
import { getSettings } from './settings.js';

const TTL_MS = 10 * 60 * 1000;
const CONCURRENCY = 5;

const tasks = new Map();

function prune() {
  const now = Date.now();
  for (const [id, t] of tasks) {
    if (now - t.createdAt > TTL_MS) tasks.delete(id);
  }
}

export function createBatchCheck({ db, fetchImpl, rows }) {
  prune();
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
  runBatch(db, fetchImpl, task, rows).catch(() => {}); // 行级错误已在自检函数内兜底
  return id;
}

async function runBatch(db, fetchImpl, task, rows) {
  const timeoutMs = getSettings(db).selfcheck.timeout_seconds * 1000;
  const queue = [...rows];
  const worker = async () => {
    while (queue.length) {
      const file = queue.shift();
      if (!file) return;
      const internal = runInternalCheck(db, file);
      const external = await runExternalCheck(file, {
        ...(fetchImpl ? { fetchImpl } : {}),
        timeoutMs,
      });
      task.results.set(file.id, { internal, external });
      task.done++;
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  task.status = 'done';
}

export function getBatchCheck(id) {
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
