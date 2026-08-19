import { getCookie } from 'hono/cookie';
import { getSessionUser } from './repo/sessions.js';

export const COOKIE_NAME = 'sid';

export function sessionMiddleware({ db }) {
  return async (c, next) => {
    const token = getCookie(c, COOKIE_NAME);
    c.set('sessionToken', token || null);
    c.set('user', token ? getSessionUser(db, token) : undefined);
    await next();
  };
}

export function requireAuth(c, next) {
  if (!c.get('user')) return c.json({ error: 'unauthorized' }, 401);
  return next();
}

export function requireSuper(c, next) {
  const user = c.get('user');
  if (!user) return c.json({ error: 'unauthorized' }, 401);
  if (!user.is_super) return c.json({ error: 'forbidden' }, 403);
  return next();
}

export function issueSessionCookie(c, token, { sessionTtlHours, cookieSecure }) {
  const parts = [
    `${COOKIE_NAME}=${token}`,
    'HttpOnly',
    'SameSite=Lax',
    'Path=/',
    `Max-Age=${Math.floor(sessionTtlHours * 3600)}`,
  ];
  if (cookieSecure) parts.push('Secure');
  c.header('Set-Cookie', parts.join('; '));
}
