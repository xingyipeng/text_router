import { Hono } from 'hono';
import { requireAuth } from '../auth.js';

export function createRequestLogRoutes({ requestLog }) {
  const router = new Hono();
  router.use('*', requireAuth);
  router.get('/', (c) => c.json(requestLog.list()));
  return router;
}
