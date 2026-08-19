import { randomBytes } from 'node:crypto';

const HOUR_MS = 3600 * 1000;

export function createSession(db, userId, ttlHours) {
  const token = randomBytes(32).toString('hex');
  const now = Date.now();
  db.prepare('INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?,?,?,?)')
    .run(token, userId, now, now + ttlHours * HOUR_MS);
  return token;
}

export function getSessionUser(db, token) {
  if (typeof token !== 'string' || token.length === 0) return undefined;
  const now = Date.now();
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now);
  return db.prepare(`
    SELECT u.id, u.username, u.display_name, u.is_super
    FROM sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.token = ? AND s.expires_at > ? AND u.disabled_at IS NULL
  `).get(token, now);
}

export function deleteSession(db, token) {
  db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}
