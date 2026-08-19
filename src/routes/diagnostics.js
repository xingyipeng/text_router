import { Hono } from 'hono';
import { requireAuth } from '../auth.js';

export function createDiagnosticsRoutes({ diagnostics }) {
  const router = new Hono();
  router.use('*', requireAuth);
  router.get('/recent-requests', (c) => c.json(diagnostics.list()));
  return router;
}
