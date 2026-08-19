import { serve } from '@hono/node-server';
import { join } from 'node:path';
import { openDb } from './db.js';
import { createDiagnostics } from './diagnostics.js';
import { createApp } from './app.js';
import { ensureSuperAdmin } from './init.js';

const config = {
  port: Number(process.env.PORT || 3000),
  dataDir: process.env.DATA_DIR || './data',
  sessionTtlHours: Number(process.env.SESSION_TTL_HOURS || 168),
  cookieSecure: process.env.COOKIE_SECURE === 'true',
  staticRoot: './public',
};

const db = openDb(join(config.dataDir, 'wx_router.db'));

try {
  const result = ensureSuperAdmin(db, {
    username: process.env.SUPER_ADMIN_USER,
    password: process.env.SUPER_ADMIN_PASSWORD,
  });
  if (result.created) {
    console.log(`[init] 已创建超级管理员：${process.env.SUPER_ADMIN_USER}`);
  }
} catch (err) {
  console.error(`[fatal] ${err.message}`);
  process.exit(1);
}

const app = createApp({ db, diagnostics: createDiagnostics(), config });

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`[ready] wx_router 监听 :${info.port}，数据目录 ${config.dataDir}`);
});
