import { Hono } from 'hono';
import { findActiveByUsername, setPassword } from '../repo/users.js';
import { createSession, deleteSession } from '../repo/sessions.js';
import { verifyPassword } from '../password.js';
import { MIN_PASSWORD_LENGTH } from '../validate.js';
import { requireAuth, issueSessionCookie, COOKIE_NAME } from '../auth.js';

export function createAuthRoutes({ db, config }) {
  const router = new Hono();

  router.post('/login', async (c) => {
    let body;
    try { body = await c.req.json(); } catch { return c.json({ error: 'bad request' }, 400); }
    const { username, password } = body || {};

    const row = typeof username === 'string' ? findActiveByUsername(db, username) : undefined;
    const ok = row && typeof password === 'string' && verifyPassword(password, row.password_hash);
    if (!ok) return c.json({ error: '用户名或密码不正确' }, 401);

    const token = createSession(db, row.id, config.sessionTtlHours);
    issueSessionCookie(c, token, config);
    return c.json({
      id: row.id,
      username: row.username,
      display_name: row.display_name,
      is_super: row.is_super,
    });
  });

  router.post('/logout', (c) => {
    const token = c.get('sessionToken');
    if (token) deleteSession(db, token);
    c.header('Set-Cookie', `${COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
    return c.body(null, 204);
  });

  router.get('/me', requireAuth, (c) => c.json(c.get('user')));

  router.post('/password', requireAuth, async (c) => {
    const user = c.get('user');
    let body;
    try { body = await c.req.json(); } catch { return c.json({ error: 'bad request' }, 400); }
    const { old_password, new_password } = body || {};

    const row = findActiveByUsername(db, user.username);
    if (!row || !verifyPassword(String(old_password ?? ''), row.password_hash)) {
      return c.json({ error: '旧密码不正确' }, 400);
    }
    if (typeof new_password !== 'string' || new_password.length < MIN_PASSWORD_LENGTH) {
      return c.json({ error: `新密码至少 ${MIN_PASSWORD_LENGTH} 个字符` }, 400);
    }

    setPassword(db, user.id, new_password);
    const token = createSession(db, user.id, config.sessionTtlHours);
    issueSessionCookie(c, token, config);
    return c.json({ ok: true });
  });

  return router;
}
