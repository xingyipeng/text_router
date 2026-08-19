import { Hono } from 'hono';
import { serveStatic } from '@hono/node-server/serve-static';
import { createVerifyHandler } from './verify.js';
import { sessionMiddleware } from './auth.js';
import { createAuthRoutes } from './routes/auth.js';
import { createFileRoutes } from './routes/files.js';
import { createUserRoutes } from './routes/users.js';
import { createDiagnosticsRoutes } from './routes/diagnostics.js';

export function createApp({ db, diagnostics, config }) {
  const app = new Hono();

  // 校验文件响应：公开路径，不经过任何鉴权中间件
  app.get('/:filename{[^/]+\\.txt}', createVerifyHandler({ db, diagnostics }));

  app.use('/api/*', sessionMiddleware({ db }));
  app.route('/api/auth', createAuthRoutes({ db, config }));
  app.route('/api/files', createFileRoutes({ db, fetchImpl: config.fetchImpl }));
  app.route('/api/users', createUserRoutes({ db }));
  app.route('/api/diagnostics', createDiagnosticsRoutes({ diagnostics }));

  if (config.staticRoot) {
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
