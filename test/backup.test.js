import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync,
  existsSync, readdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { openDb } from '../src/db.js';
import { createUser } from '../src/repo/users.js';
import { createRequestLog } from '../src/requestlog.js';
import { createApp } from '../src/app.js';
import {
  BACKUP_NAME_RE, runBackup, listBackups, deleteBackup, pruneBackups,
  getBackupSettings, setBackupSettings, maybeRunScheduledBackup,
} from '../src/backup.js';

async function loginAs(app, username, password) {
  const res = await app.request('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', host: 'admin.local' },
    body: JSON.stringify({ username, password }),
  });
  return (res.headers.get('set-cookie') || '').split(';')[0];
}

// ==================== 核心逻辑（src/backup.js） ====================

describe('runBackup / 剪枝', () => {
  let dir, db;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wxr-core-'));
    db = openDb(join(dir, 'test.db'));
    createUser(db, { username: 'root', password: 'password1234', isSuper: true });
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('产出单文件备份，无 -wal/-shm/.tmp 伴生文件，内容可查', async () => {
    const bk = join(dir, 'backups');
    const r = await runBackup(db, bk, 14);
    expect(r.filename).toMatch(BACKUP_NAME_RE);
    expect(readdirSync(bk)).toEqual([r.filename]);
    expect(r.sizeKb).toBeGreaterThan(0);

    const copy = new Database(join(bk, r.filename), { readonly: true });
    expect(copy.prepare('SELECT username FROM users').all().map((u) => u.username)).toEqual(['root']);
    copy.close();
  });

  it('runBackup 会按 keep 清理最旧的备份', async () => {
    const bk = join(dir, 'backups');
    const r1 = await runBackup(db, bk, 2);
    const r2 = await runBackup(db, bk, 2);
    const r3 = await runBackup(db, bk, 2);
    const names = readdirSync(bk).sort();
    expect(names).toHaveLength(2);
    // 按创建时间（mtime）剪枝：最旧的 r1 被清掉，即使它文件名上没有 -N 后缀
    expect(names).toEqual([r2.filename, r3.filename].sort());
    expect(names).not.toContain(r1.filename);
  });

  it('pruneBackups 忽略无关文件', () => {
    const bk = join(dir, 'prune');
    mkdirSync(bk, { recursive: true });
    for (const f of [
      'wx_router-20240101-000000.db',
      'wx_router-20240102-000000.db',
      'wx_router-20240103-000000.db',
      'junk.txt',
      'wx_router-20240103-000000.db.tmp',
    ]) {
      writeFileSync(join(bk, f), 'x');
    }
    const removed = pruneBackups(bk, 2);
    expect(removed).toEqual(['wx_router-20240101-000000.db']);
    expect(readdirSync(bk).sort()).toEqual([
      'junk.txt',
      'wx_router-20240102-000000.db',
      'wx_router-20240103-000000.db',
      'wx_router-20240103-000000.db.tmp',
    ]);
  });
});

describe('listBackups / deleteBackup', () => {
  let dir;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wxr-list-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('目录不存在时列表为空', () => {
    expect(listBackups(join(dir, 'nope'))).toEqual([]);
  });

  it('过滤无关文件并按名字新到旧排序', () => {
    for (const f of [
      'wx_router-20240101-000000.db',
      'wx_router-20240102-000000.db',
      'wx_router-20240103-000000-1.db',
      'junk.txt',
    ]) {
      writeFileSync(join(dir, f), 'x');
    }
    const list = listBackups(dir);
    expect(list.map((b) => b.name)).toEqual([
      'wx_router-20240103-000000-1.db',
      'wx_router-20240102-000000.db',
      'wx_router-20240101-000000.db',
    ]);
    expect(list[0].size).toBe(1);
    expect(list[0].mtimeMs).toBeGreaterThan(0);
  });

  it('deleteBackup 拒绝白名单外的名字', () => {
    expect(() => deleteBackup(dir, '../evil.db')).toThrow('非法的备份文件名');
    expect(() => deleteBackup(dir, 'wx_router-20240101-000000.db.tmp')).toThrow('非法的备份文件名');
  });

  it('deleteBackup 删除不存在的备份时报错', () => {
    expect(() => deleteBackup(dir, 'wx_router-20240101-000000.db')).toThrow('备份不存在');
  });

  it('deleteBackup 成功删除', () => {
    writeFileSync(join(dir, 'wx_router-20240101-000000.db'), 'x');
    deleteBackup(dir, 'wx_router-20240101-000000.db');
    expect(existsSync(join(dir, 'wx_router-20240101-000000.db'))).toBe(false);
  });
});

describe('备份设置', () => {
  let dir, db;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wxr-settings-'));
    db = openDb(join(dir, 'test.db'));
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('默认值：关闭 / 03:17 / 保留 14', () => {
    expect(getBackupSettings(db)).toEqual({ enabled: false, time: '03:17', keep: 14 });
  });

  it('非法输入抛中文错误', () => {
    expect(() => setBackupSettings(db, { enabled: 'yes', time: '03:17', keep: 14 })).toThrow('布尔');
    expect(() => setBackupSettings(db, { enabled: true, time: '25:00', keep: 14 })).toThrow('HH:MM');
    expect(() => setBackupSettings(db, { enabled: true, time: '03:17', keep: 0 })).toThrow('1-1000');
    expect(() => setBackupSettings(db, { enabled: true, time: '03:17', keep: 1001 })).toThrow('1-1000');
    expect(() => setBackupSettings(db, { enabled: true, time: '03:17', keep: 1.5 })).toThrow('1-1000');
  });

  it('写入后可回读', () => {
    const saved = setBackupSettings(db, { enabled: true, time: '23:59', keep: 5 });
    expect(saved).toEqual({ enabled: true, time: '23:59', keep: 5 });
    expect(getBackupSettings(db)).toEqual({ enabled: true, time: '23:59', keep: 5 });
  });
});

describe('maybeRunScheduledBackup', () => {
  let dir, db;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wxr-sched-'));
    db = openDb(join(dir, 'test.db'));
    createUser(db, { username: 'root', password: 'password1234', isSuper: true });
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('未启用时永不执行', async () => {
    const state = {};
    const r = await maybeRunScheduledBackup(
      { db, dir: join(dir, 'bk'), state }, new Date(2026, 0, 1, 3, 17));
    expect(r.ran).toBe(false);
  });

  it('分钟匹配时执行一次，同分钟守卫防重跑', async () => {
    setBackupSettings(db, { enabled: true, time: '03:17', keep: 14 });
    const bk = join(dir, 'bk');
    const state = {};

    const r1 = await maybeRunScheduledBackup({ db, dir: bk, state }, new Date(2026, 0, 1, 3, 17));
    expect(r1.ran).toBe(true);
    expect(r1.filename).toMatch(BACKUP_NAME_RE);
    expect(existsSync(join(bk, r1.filename))).toBe(true);

    const r2 = await maybeRunScheduledBackup({ db, dir: bk, state }, new Date(2026, 0, 1, 3, 17));
    expect(r2.ran).toBe(false);
    expect(readdirSync(bk)).toHaveLength(1);
  });

  it('分钟不匹配时不执行', async () => {
    setBackupSettings(db, { enabled: true, time: '03:17', keep: 14 });
    const state = {};
    const r = await maybeRunScheduledBackup(
      { db, dir: join(dir, 'bk'), state }, new Date(2026, 0, 1, 3, 18));
    expect(r.ran).toBe(false);
    expect(existsSync(join(dir, 'bk'))).toBe(false);
  });
});

// ==================== 路由（/api/backups） ====================

describe('备份路由', () => {
  let dir, db, app, superCookie, plainCookie, backupDir;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'wxr-routes-'));
    backupDir = join(dir, 'backups');
    db = openDb(join(dir, 'test.db'));
    app = createApp({
      db,
      requestLog: createRequestLog(),
      config: {
        dbPath: join(dir, 'test.db'),
        backupDir,
        restartImpl: () => {},
        sessionTtlHours: 24,
        cookieSecure: false,
      },
    });
    createUser(db, { username: 'root', password: 'password1234', isSuper: true });
    createUser(db, { username: 'alice', password: 'password1234' });
    superCookie = await loginAs(app, 'root', 'password1234');
    plainCookie = await loginAs(app, 'alice', 'password1234');
  });
  afterEach(() => {
    try { db.close(); } catch {}
    rmSync(dir, { recursive: true, force: true });
  });

  const as = (cookie) => (path, method = 'GET', body) =>
    app.request(path, {
      method,
      headers: { 'content-type': 'application/json', host: 'admin.local', cookie },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  const ALL_PATHS = [
    ['/api/backups/settings', 'GET'],
    ['/api/backups/settings', 'PUT'],
    ['/api/backups', 'POST'],
    ['/api/backups', 'GET'],
    ['/api/backups/wx_router-20240101-000000.db/download', 'GET'],
    ['/api/backups/wx_router-20240101-000000.db', 'DELETE'],
    ['/api/backups/wx_router-20240101-000000.db/restore', 'POST'],
  ];

  describe('权限', () => {
    it('未登录一律 401', async () => {
      for (const [path, method] of ALL_PATHS) {
        const res = await app.request(path, { method, headers: { host: 'admin.local' } });
        expect(res.status, `${method} ${path}`).toBe(401);
      }
    });

    it('普通用户一律 403', async () => {
      for (const [path, method] of ALL_PATHS) {
        const res = await app.request(path, {
          method,
          headers: { host: 'admin.local', cookie: plainCookie },
        });
        expect(res.status, `${method} ${path}`).toBe(403);
      }
    });
  });

  describe('设置', () => {
    it('GET 返回默认值，且不被 /:name 路由吞掉', async () => {
      const res = await as(superCookie)('/api/backups/settings');
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ enabled: false, time: '03:17', keep: 14 });
    });

    it('PUT 保存后 GET 可回读', async () => {
      const res = await as(superCookie)('/api/backups/settings', 'PUT',
        { enabled: true, time: '23:59', keep: 5 });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ enabled: true, time: '23:59', keep: 5 });
      const back = await as(superCookie)('/api/backups/settings');
      expect(await back.json()).toEqual({ enabled: true, time: '23:59', keep: 5 });
    });

    it('非法值一律 400', async () => {
      expect((await as(superCookie)('/api/backups/settings', 'PUT',
        { enabled: true, time: '25:00', keep: 14 })).status).toBe(400);
      expect((await as(superCookie)('/api/backups/settings', 'PUT',
        { enabled: true, time: '03:17', keep: 0 })).status).toBe(400);
      expect((await as(superCookie)('/api/backups/settings', 'PUT',
        { enabled: 'yes', time: '03:17', keep: 14 })).status).toBe(400);
      expect((await as(superCookie)('/api/backups/settings', 'PUT', 'oops')).status).toBe(400);
    });
  });

  describe('备份管理', () => {
    it('POST 创建备份，出现在列表中', async () => {
      const res = await as(superCookie)('/api/backups', 'POST');
      expect(res.status).toBe(201);
      const r = await res.json();
      expect(r.filename).toMatch(BACKUP_NAME_RE);
      expect(existsSync(join(backupDir, r.filename))).toBe(true);

      const list = await (await as(superCookie)('/api/backups')).json();
      expect(list.map((b) => b.name)).toContain(r.filename);
      expect(list[0].size).toBeGreaterThan(0);
      expect(list[0].mtimeMs).toBeGreaterThan(0);
    });

    it('列表按新到旧排序且忽略无关文件', async () => {
      const r1 = await runBackup(db, backupDir, 14);
      writeFileSync(join(backupDir, 'junk.txt'), 'x');
      const r2 = await runBackup(db, backupDir, 14);
      const list = await (await as(superCookie)('/api/backups')).json();
      expect(list.map((b) => b.name)).toEqual([r2.filename, r1.filename]);
    });

    it('下载返回磁盘字节与正确的响应头', async () => {
      const r = await runBackup(db, backupDir, 14);
      const res = await as(superCookie)(`/api/backups/${r.filename}/download`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('application/octet-stream');
      expect(res.headers.get('content-disposition')).toBe(`attachment; filename="${r.filename}"`);
      const bytes = Buffer.from(await res.arrayBuffer());
      expect(bytes.equals(readFileSync(join(backupDir, r.filename)))).toBe(true);
    });

    it('DELETE 删除备份', async () => {
      const r = await runBackup(db, backupDir, 14);
      const res = await as(superCookie)(`/api/backups/${r.filename}`, 'DELETE');
      expect(res.status).toBe(204);
      expect(existsSync(join(backupDir, r.filename))).toBe(false);
    });

    it('非法文件名一律 404（防路径穿越）', async () => {
      const cases = [
        ['/api/backups/evil.db/download', 'GET'],
        ['/api/backups/evil.db', 'DELETE'],
        ['/api/backups/evil.db/restore', 'POST'],
        ['/api/backups/..%2Ftest.db/download', 'GET'],
        ['/api/backups/wx_router-20240101-000000.db.tmp/download', 'GET'],
      ];
      for (const [path, method] of cases) {
        const res = await as(superCookie)(path, method);
        expect(res.status, path).toBe(404);
      }
    });

    it('删除不存在的备份 404', async () => {
      const res = await as(superCookie)('/api/backups/wx_router-20240101-000000.db', 'DELETE');
      expect(res.status).toBe(404);
    });
  });
});

// ==================== 恢复（独立实例：restore 会关闭 db） ====================

describe('恢复备份', () => {
  let dir, dbPath, backupDir, app, restartCalled, cookie;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'wxr-restore-'));
    dbPath = join(dir, 'test.db');
    backupDir = join(dir, 'backups');
    restartCalled = false;
    const db = openDb(dbPath);
    app = createApp({
      db,
      requestLog: createRequestLog(),
      config: {
        dbPath,
        backupDir,
        restartImpl: () => { restartCalled = true; },
        sessionTtlHours: 24,
        cookieSecure: false,
      },
    });
    createUser(db, { username: 'root', password: 'password1234', isSuper: true });
    cookie = await loginAs(app, 'root', 'password1234');
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const post = (path, body) => app.request(path, {
    method: 'POST',
    headers: body === undefined
      ? { host: 'admin.local', cookie }
      : { 'content-type': 'application/json', host: 'admin.local', cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  it('恢复后磁盘库内容=备份内容，留底存在，且调用了重启', async () => {
    // 备份通过路由创建（不需要直接持有 db 引用）
    const backupRes = await post('/api/backups');
    expect(backupRes.status).toBe(201);
    const { filename } = await backupRes.json();

    // 备份之后新增一条数据，恢复后应消失
    const addRes = await post('/api/users', { username: 'alice', password: 'password1234' });
    expect(addRes.status).toBe(201);

    const res = await post(`/api/backups/${filename}/restore`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ message: '恢复完成，服务即将重启' });
    expect(restartCalled).toBe(true);

    expect(existsSync(`${dbPath}.before-restore`)).toBe(true);
    expect(existsSync(`${dbPath}-wal`)).toBe(false);
    expect(existsSync(`${dbPath}-shm`)).toBe(false);

    const chk = new Database(dbPath, { readonly: true });
    expect(chk.prepare('SELECT username FROM users').all().map((u) => u.username)).toEqual(['root']);
    chk.close();
  });

  it('非法文件名 404', async () => {
    const res = await post('/api/backups/evil.db/restore');
    expect(res.status).toBe(404);
  });

  it('备份文件不存在 500 且不触发重启', async () => {
    const res = await post('/api/backups/wx_router-20240101-000000.db/restore');
    expect(res.status).toBe(500);
    expect((await res.json()).error).toContain('恢复失败');
    expect(restartCalled).toBe(false);
  });
});
