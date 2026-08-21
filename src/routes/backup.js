import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import Database from 'better-sqlite3';
import { Readable } from 'node:stream';
import { createReadStream, existsSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { requireSuper } from '../auth.js';
import {
  runBackup, listBackups, deleteBackup, restoreBackup, replaceDbFile,
  getBackupSettings, setBackupSettings, BACKUP_NAME_RE,
} from '../backup.js';

const DEFAULT_RESTART = () => setTimeout(() => process.exit(0), 200);

export function createBackupRoutes({ db, config }) {
  const { dbPath, backupDir } = config;
  const restartImpl = config.restartImpl || DEFAULT_RESTART;
  const router = new Hono();
  router.use('*', requireSuper);

  // 注意：/settings 必须先于 /:name 注册，否则会被参数路由吞掉
  router.get('/settings', (c) => c.json(getBackupSettings(db)));

  router.put('/settings', async (c) => {
    let body;
    try { body = await c.req.json(); } catch { return c.json({ error: 'bad request' }, 400); }
    try {
      return c.json(setBackupSettings(db, {
        enabled: body?.enabled,
        time: body?.time,
        keep: body?.keep,
      }));
    } catch (err) {
      return c.json({ error: err.message }, 400);
    }
  });

  // 注意：/upload 必须先于 /:name 注册，否则会被参数路由吞掉
  router.post('/upload', bodyLimit({
    maxSize: config.uploadMaxBytes ?? 100 * 1024 * 1024, // 默认上限 100MB，测试可经 config 调小
    onError: (c) => c.json({ error: '文件过大' }, 413),
  }), async (c) => {
    const buf = await c.req.arrayBuffer();
    if (!buf.byteLength) return c.json({ error: '上传内容为空' }, 400);

    // 临时文件与库文件同目录；名字不匹配 BACKUP_NAME_RE，不会被备份列表/剪枝误伤
    const tmpPath = `${dbPath}.upload-${Date.now()}${Math.random().toString(36).slice(2, 8)}.db`;
    try {
      writeFileSync(tmpPath, Buffer.from(buf));

      // 只读打开跑完整性校验；打不开（垃圾字节）或校验失败都视为无效库
      let ok;
      try {
        const chk = new Database(tmpPath, { readonly: true, fileMustExist: true });
        try { ok = chk.pragma('integrity_check', { simple: true }); } finally { chk.close(); }
      } catch { ok = 'not a database'; }
      if (ok !== 'ok') return c.json({ error: `数据库完整性校验失败：${ok}` }, 400);

      const r = replaceDbFile({ db, dbPath, srcPath: tmpPath });
      // 先调度重启（默认延迟 200ms，让响应先发出去），再返回
      restartImpl();
      return c.json({ message: '恢复完成，服务即将重启', beforeRestore: r.beforeRestore });
    } catch (err) {
      return c.json({ error: `恢复失败：${err.message}` }, 500);
    } finally {
      try { if (existsSync(tmpPath)) unlinkSync(tmpPath); } catch {}
    }
  });

  router.post('/', async (c) => {
    try {
      const r = await runBackup(db, backupDir, getBackupSettings(db).keep);
      return c.json(r, 201);
    } catch (err) {
      return c.json({ error: `备份失败：${err.message}` }, 500);
    }
  });

  router.get('/', (c) => c.json(listBackups(backupDir)));

  router.get('/:name/download', (c) => {
    const name = c.req.param('name');
    if (!BACKUP_NAME_RE.test(name)) return c.body('Not found', 404);
    const p = join(backupDir, name);
    if (!existsSync(p)) return c.body('Not found', 404);
    return c.body(Readable.toWeb(createReadStream(p)), 200, {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${name}"`,
      'Cache-Control': 'no-store',
    });
  });

  router.delete('/:name', (c) => {
    const name = c.req.param('name');
    if (!BACKUP_NAME_RE.test(name)) return c.body('Not found', 404);
    try {
      deleteBackup(backupDir, name);
      return c.body(null, 204);
    } catch (err) {
      return c.json({ error: err.message }, 404);
    }
  });

  router.post('/:name/restore', (c) => {
    const name = c.req.param('name');
    if (!BACKUP_NAME_RE.test(name)) return c.body('Not found', 404);
    try {
      const r = restoreBackup({ db, dbPath, dir: backupDir, name });
      // 先调度重启（默认延迟 200ms，让响应先发出去），再返回
      restartImpl();
      return c.json({ message: '恢复完成，服务即将重启', beforeRestore: r.beforeRestore });
    } catch (err) {
      return c.json({ error: `恢复失败：${err.message}` }, 500);
    }
  });

  return router;
}
