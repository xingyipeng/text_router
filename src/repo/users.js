import { hashPassword } from '../password.js';
import { wrapUnique } from './errors.js';

const SAFE_COLUMNS =
  'id, username, display_name, is_super, created_at, created_by, disabled_at';

export function createUser(db, { username, password, displayName = '', isSuper = false, createdBy = null }) {
  const info = wrapUnique(() =>
    db.prepare(`
      INSERT INTO users (username, password_hash, display_name, is_super, created_at, created_by)
      VALUES (?,?,?,?,?,?)
    `).run(username, hashPassword(password), displayName, isSuper ? 1 : 0, Date.now(), createdBy)
  );
  return getUser(db, info.lastInsertRowid);
}

export function getUser(db, id) {
  return db.prepare(`SELECT ${SAFE_COLUMNS} FROM users WHERE id = ?`).get(id);
}

export function findActiveByUsername(db, username) {
  return db.prepare('SELECT * FROM users WHERE username = ? AND disabled_at IS NULL').get(username);
}

export function listUsers(db, { includeDisabled = false } = {}) {
  const clause = includeDisabled ? '' : 'WHERE disabled_at IS NULL';
  return db.prepare(`SELECT ${SAFE_COLUMNS} FROM users ${clause} ORDER BY created_at ASC`).all();
}

export function disableUser(db, id) {
  db.transaction(() => {
    db.prepare('UPDATE users SET disabled_at = ? WHERE id = ? AND disabled_at IS NULL')
      .run(Date.now(), id);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
  })();
  return getUser(db, id);
}

export function restoreUser(db, id) {
  wrapUnique(() =>
    db.prepare('UPDATE users SET disabled_at = NULL WHERE id = ? AND disabled_at IS NOT NULL').run(id)
  );
  return getUser(db, id);
}

export function setPassword(db, id, password) {
  db.transaction(() => {
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(password), id);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
  })();
  return getUser(db, id);
}

export function countUsers(db) {
  return db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
}
