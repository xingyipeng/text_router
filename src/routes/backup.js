import { Hono } from 'hono';
import { Readable } from 'node:stream';
import { createReadStream, existsSync } from 'node:fs';
import { join } from 'node:path';
import { requireSuper } from '../auth.js';
import {
  runBackup, listBackups, deleteBackup, restoreBackup,
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
