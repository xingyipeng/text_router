import { Hono } from 'hono';
import { serveStatic } from '@hono/node-server/serve-static';
import { createVerifyHandler } from './verify.js';
import { sessionMiddleware } from './auth.js';
import { createAuthRoutes } from './routes/auth.js';
import { createRulesRoutes } from './routes/rules.js';
import { createUserRoutes } from './routes/users.js';
import { createRequestLogRoutes } from './routes/requestlog.js';
import { createStatsRoutes } from './routes/stats.js';
import { createBackupRoutes } from './routes/backup.js';
import { createSettingsRoutes } from './routes/settings.js';
import { createDocsRoutes } from './routes/docs.js';

export function createApp({ db, requestLog, config }) {
  const app = new Hono();

  // 校验文件响应：公开路径，不经过任何鉴权中间件。
  // 任意路径先查规则（路径不限制扩展名）：命中即返回；.txt 未命中 404 留痕；
  // 其余路径未命中返回 null 透传 next()，交给静态文件与 notFound。
  app.get('*', (c, next) => {
    const res = createVerifyHandler({ db, requestLog })(c);
    if (res === null) return next();
    return res;
  });

  app.use('/api/*', sessionMiddleware({ db }));

  // 版本信息：公开接口（无需登录），供前端展示版本号与 console 横幅
  app.get('/api/version', (c) => c.json({ version: config.version ?? 'dev' }));
  app.route('/api/auth', createAuthRoutes({ db, config }));
  app.route('/api/rules', createRulesRoutes({ db, fetchImpl: config.fetchImpl }));
  app.route('/api/users', createUserRoutes({ db }));
  app.route('/api/request-log', createRequestLogRoutes({ db, requestLog }));
  app.route('/api/stats', createStatsRoutes({ db, requestLog }));
  app.route('/api/backups', createBackupRoutes({ db, config }));
  app.route('/api/settings', createSettingsRoutes({ db, requestLog, config }));
  app.route('/api/docs', createDocsRoutes({ docsDir: config.docsDir }));

  if (config.staticRoot) {
    // 静态文件体积都很小，要求浏览器每次重新校验，改版后无需手动强刷
    app.use('/*', async (c, next) => {
      await next();
      if (!c.res.headers.get('cache-control')) {
        c.res.headers.set('Cache-Control', 'no-cache');
      }
    });
    app.use('/*', serveStatic({ root: config.staticRoot }));
  }

  app.notFound((c) =>
    c.body('Not found', 404, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
    })
  );

  return app;
}
