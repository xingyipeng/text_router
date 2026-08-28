import { Hono } from 'hono';
import { requireAuth } from '../auth.js';
import { listRequests, clearRequests } from '../repo/requests.js';

export function createRequestLogRoutes({ db, requestLog }) {
  const router = new Hono();
  router.use('*', requireAuth);

  // 分页查库（持久化日志）；?before=<id> 取更早一页，?limit= 每页条数（默认 200，上限 500）
  router.get('/', (c) => {
    const q = c.req.query();
    const beforeId = q.before === undefined ? undefined : Number(q.before);
    return c.json(listRequests(db, { beforeId, limit: q.limit }));
  });

  router.post('/clear', (c) => {
    // 库与内存一并清空（内存供看板实时统计）
    clearRequests(db);
    requestLog.clear();
    return c.json({ message: '已清空' });
  });

  return router;
}
