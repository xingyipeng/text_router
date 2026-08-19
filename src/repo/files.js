import { wrapUnique } from './errors.js';

const SELECT_WITH_USERS = `
  SELECT f.*,
         cu.username AS created_by_username, cu.display_name AS created_by_name,
         uu.username AS updated_by_username, uu.display_name AS updated_by_name,
         du.username AS deleted_by_username, du.display_name AS deleted_by_name
  FROM verify_files f
  LEFT JOIN users cu ON cu.id = f.created_by
  LEFT JOIN users uu ON uu.id = f.updated_by
  LEFT JOIN users du ON du.id = f.deleted_by
`;

export function createFile(db, { host, filename, content, note = '', userId }) {
  const now = Date.now();
  const info = wrapUnique(() =>
    db.prepare(`
      INSERT INTO verify_files
        (host, filename, content, note, created_at, created_by, updated_at, updated_by)
      VALUES (?,?,?,?,?,?,?,?)
    `).run(host, filename, content, note, now, userId, now, userId)
  );
  return getFile(db, info.lastInsertRowid);
}

export function updateFile(db, id, { host, filename, content, note, userId }) {
  wrapUnique(() =>
    db.prepare(`
      UPDATE verify_files
      SET host = ?, filename = ?, content = ?, note = ?, updated_at = ?, updated_by = ?
      WHERE id = ? AND deleted_at IS NULL
    `).run(host, filename, content, note, Date.now(), userId, id)
  );
  return getFile(db, id);
}

export function getFile(db, id) {
  return db.prepare(`${SELECT_WITH_USERS} WHERE f.id = ?`).get(id);
}

export function softDeleteFile(db, id, userId) {
  db.prepare(`
    UPDATE verify_files SET deleted_at = ?, deleted_by = ?
    WHERE id = ? AND deleted_at IS NULL
  `).run(Date.now(), userId, id);
  return getFile(db, id);
}

export function restoreFile(db, id, userId) {
  wrapUnique(() =>
    db.prepare(`
      UPDATE verify_files
      SET deleted_at = NULL, deleted_by = NULL, updated_at = ?, updated_by = ?
      WHERE id = ? AND deleted_at IS NOT NULL
    `).run(Date.now(), userId, id)
  );
  return getFile(db, id);
}

export function matchFile(db, host, filename) {
  return db.prepare(`
    SELECT id, content FROM verify_files
    WHERE filename = ? AND deleted_at IS NULL AND (host = ? OR host = '')
    ORDER BY (host = '') ASC
    LIMIT 1
  `).get(filename, host);
}

export function listFiles(db, { host, q, by, includeDeleted = false } = {}) {
  const where = [];
  const params = [];
  if (!includeDeleted) where.push('f.deleted_at IS NULL');
  if (host !== undefined && host !== null && host !== '') {
    where.push('f.host = ?');
    params.push(host);
  }
  if (q) {
    where.push('(f.filename LIKE ? OR f.note LIKE ?)');
    params.push(`%${q}%`, `%${q}%`);
  }
  if (by) {
    where.push('(f.created_by = ? OR f.updated_by = ?)');
    params.push(by, by);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  return db.prepare(`${SELECT_WITH_USERS} ${clause} ORDER BY f.updated_at DESC`).all(...params);
}
