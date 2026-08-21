import { Hono } from 'hono';
import { requireAuth } from '../auth.js';

export function createRequestLogRoutes({ requestLog }) {
  const router = new Hono();
  router.use('*', requireAuth);
  router.get('/', (c) => c.json(requestLog.list()));
  router.post('/clear', (c) => {
    requestLog.clear();
    return c.json({ message: '已清空' });
  });
  return router;
}
