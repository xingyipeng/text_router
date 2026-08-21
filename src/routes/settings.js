import { Hono } from 'hono';
import { requireSuper } from '../auth.js';
import { getSettings, setSettings } from '../settings.js';

export function createSettingsRoutes({ db, requestLog, config }) {
  const router = new Hono();
  router.use('*', requireSuper);

  const read = () => getSettings(db, { sessionTtlHours: config.sessionTtlHours });

  router.get('/', (c) => c.json(read()));

  router.put('/', async (c) => {
    let body;
    try { body = await c.req.json(); } catch { return c.json({ error: 'bad request' }, 400); }
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return c.json({ error: '请求体必须是对象' }, 400);
    }
    try {
      setSettings(db, body);
    } catch (err) {
      return c.json({ error: err.message }, 400);
    }
    const saved = read();
    // 请求记录容量改后立即生效（裁剪已缓存的记录）
    requestLog.setCapacity(saved.requestlog.capacity);
    return c.json(saved);
  });

  return router;
}
