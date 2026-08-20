import { Hono } from 'hono';
import { requireAuth } from '../auth.js';
import { computeStats } from '../stats.js';

export function createStatsRoutes({ db, requestLog }) {
  const router = new Hono();
  router.use('*', requireAuth);
  router.get('/', (c) => c.json(computeStats(db, requestLog)));
  return router;
}
