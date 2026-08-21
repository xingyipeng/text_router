import { serve } from '@hono/node-server';
import { join } from 'node:path';
import { openDb } from './db.js';
import { createRequestLog } from './requestlog.js';
import { createApp } from './app.js';
import { ensureSuperAdmin } from './init.js';
import { startBackupScheduler } from './backup.js';

const dataDir = process.env.DATA_DIR || './data';
const config = {
  port: Number(process.env.PORT || 3000),
  dataDir,
  dbPath: join(dataDir, 'wx_router.db'),
  backupDir: process.env.BACKUP_DIR || './backups',
  sessionTtlHours: Number(process.env.SESSION_TTL_HOURS || 168),
  cookieSecure: process.env.COOKIE_SECURE === 'true',
  staticRoot: './public',
  docsDir: process.env.DOCS_DIR || './docs',
  // 恢复后重启进程：Docker restart 策略（或 pm2/systemd）会重新拉起
  restartImpl: () => setTimeout(() => process.exit(0), 200),
};

const db = openDb(config.dbPath);

try {
  const result = ensureSuperAdmin(db, {
    username: process.env.SUPER_ADMIN_USER,
    password: process.env.SUPER_ADMIN_PASSWORD,
  });
  if (result.created) {
    console.log(`[init] 已创建超级管理员：${result.username}`);
    if (result.defaultedPassword) {
      console.warn('[warn] 未设置 SUPER_ADMIN_PASSWORD，已使用默认密码 admin123。请登录后立即修改密码！');
    }
  }
} catch (err) {
  console.error(`[fatal] ${err.message}`);
  process.exit(1);
}

const app = createApp({ db, requestLog: createRequestLog(), config });

startBackupScheduler({ db, dir: config.backupDir });

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`[ready] wx_router 已启动：http://localhost:${info.port}/`);
  console.log(`[ready] 数据目录 ${config.dataDir}，备份目录 ${config.backupDir}`);
});
