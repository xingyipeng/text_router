import { serve } from '@hono/node-server';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import pkg from '../package.json' with { type: 'json' };
import { DB_FILENAME, migrateLegacyDb, openDb } from './db.js';
import { createRequestLog } from './requestlog.js';
import { createApp } from './app.js';
import { ensureSuperAdmin } from './init.js';
import { startBackupScheduler } from './backup.js';
import { getSettings } from './settings.js';
import { trimRequests } from './repo/requests.js';
import { deployConfig, envPresets } from './config.js';

// 根目录存在 .env 时自动加载（等价 --env-file-if-missing=.env，但不挑 Node 小版本）。
// 不覆盖 shell 里已有的环境变量；文件不存在或解析失败时静默/告警继续。
{
  const envPath = join(process.cwd(), '.env');
  if (existsSync(envPath)) {
    try {
      process.loadEnvFile(envPath);
    } catch (err) {
      console.warn(`[warn] 加载 .env 失败（已忽略）：${err.message}`);
    }
  }
}

// 部署级配置从 config.js 的 DEPLOY 规格生成（env 名/默认值集中在 src/config.js）
const deploy = deployConfig();
const config = {
  version: pkg.version,
  ...deploy,
  dbPath: join(deploy.dataDir, DB_FILENAME),
  staticRoot: './public',
  // 运行级设置的初始默认值（仅 DB 无记录时生效；UI 保存后以 DB 为准）。
  // 原始 env 值在此透传，合法性校验在 settings.js / backup.js。
  defaults: envPresets(),
  // 恢复后重启进程：Docker restart 策略（或 pm2/systemd）会重新拉起
  restartImpl: () => setTimeout(() => process.exit(0), 200),
};

if (migrateLegacyDb(deploy.dataDir)) {
  console.log(`[init] 已把旧库文件 wx_router.db 迁移为 ${DB_FILENAME}`);
}
const db = openDb(config.dbPath);

try {
  const result = ensureSuperAdmin(db, {
    // env 未设置时仍传 undefined，让 init.js 走内置默认并触发「弱默认密码」警告
    username: process.env.SUPER_ADMIN_USER === undefined ? undefined : deploy.superAdminUser,
    password: process.env.SUPER_ADMIN_PASSWORD === undefined ? undefined : deploy.superAdminPassword,
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

// 请求记录容量按「DB 值 > env 初始默认 > 代码默认」算出有效值，启动即生效
// （此前只读代码默认，DB 里存过容量也要等设置页再保存一次才生效）
const requestLogCapacity = getSettings(
  db, { ...config.defaults, session: { ttl_hours: config.sessionTtlHours } }
).requestlog.capacity;
const requestLog = createRequestLog(requestLogCapacity);
// 持久化表同样按容量裁剪（停机期间容量改小或手动改库的兜底）
trimRequests(db, requestLogCapacity);

const app = createApp({ db, requestLog, config });

startBackupScheduler({ db, dir: config.backupDir, backupDefaults: config.defaults.backup });

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`[ready] text_router v${config.version} 已启动：http://localhost:${info.port}/`);
  console.log(`[ready] 数据目录 ${config.dataDir}，备份目录 ${config.backupDir}`);
});
