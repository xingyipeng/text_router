import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db.js';
import { createRequestLog } from '../src/requestlog.js';
import { createApp } from '../src/app.js';

let dir, db, requestLog;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wxr-'));
  db = openDb(join(dir, 'test.db'));
  requestLog = createRequestLog();
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('GET /api/version', () => {
  it('公开接口：未登录也返回 200', async () => {
    const app = createApp({ db, requestLog, config: { version: '1.2.3' } });
    const res = await app.request('/api/version');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(await res.json()).toEqual({ version: '1.2.3' });
  });

  it('未配置 version 时兜底返回 dev', async () => {
    const app = createApp({ db, requestLog, config: { sessionTtlHours: 1, cookieSecure: false } });
    const res = await app.request('/api/version');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ version: 'dev' });
  });

  it('不被 *.txt 通配路由拦截（无 .txt 后缀正常透传）', async () => {
    const app = createApp({ db, requestLog, config: { version: '0.0.1' } });
    const res = await app.request('/api/version.txt');
    // 以 .txt 结尾会进入校验处理器，无记录应 404（确认路由边界）
    expect(res.status).toBe(404);
    const ok = await app.request('/api/version');
    expect(ok.status).toBe(200);
  });
});
