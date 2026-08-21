import { Hono } from 'hono';
import { findActiveByUsername, setPassword } from '../repo/users.js';
import { createSession, deleteSession, deleteUserSessions } from '../repo/sessions.js';
import { verifyPassword } from '../password.js';
import { MIN_PASSWORD_LENGTH } from '../validate.js';
import { requireAuth, issueSessionCookie, COOKIE_NAME } from '../auth.js';
import { getSettings } from '../settings.js';

// 登录/改密都发新会话：TTL 取设置值（无记录回落 config.sessionTtlHours），
// 开启单机登录时先踢掉该账号的其它会话，再发新会话 cookie。
function openSession(c, db, config, userId) {
  const settings = getSettings(db, { session: { ttl_hours: config.sessionTtlHours } });
  if (settings.session.single_session) deleteUserSessions(db, userId);
  const token = createSession(db, userId, settings.session.ttl_hours);
  issueSessionCookie(c, token, { ...config, sessionTtlHours: settings.session.ttl_hours });
  return token;
}

export function createAuthRoutes({ db, config }) {
  const router = new Hono();

  router.post('/login', async (c) => {
    let body;
    try { body = await c.req.json(); } catch { return c.json({ error: 'bad request' }, 400); }
    const { username, password } = body || {};

    const row = typeof username === 'string' ? findActiveByUsername(db, username) : undefined;
    const ok = row && typeof password === 'string' && verifyPassword(password, row.password_hash);
    if (!ok) return c.json({ error: '用户名或密码不正确' }, 401);

    openSession(c, db, config, row.id);
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
    openSession(c, db, config, user.id);
    return c.json({ ok: true });
  });

  return router;
}
