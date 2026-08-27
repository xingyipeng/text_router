import { wrapUnique } from './errors.js';
import { listUsers } from './users.js';
import { matchHost, compareRules } from '../hostmatch.js';

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

export function createFile(db, { host, filename, content, note = '', priority = 0, userId }) {
  const now = Date.now();
  const info = wrapUnique(() =>
    db.prepare(`
      INSERT INTO verify_files
        (host, filename, content, note, priority, created_at, created_by, updated_at, updated_by)
      VALUES (?,?,?,?,?,?,?,?,?)
    `).run(host, filename, content, note, priority, now, userId, now, userId)
  );
  return getFile(db, info.lastInsertRowid);
}

export function updateFile(db, id, { host, filename, content, note = '', priority = 0, userId }) {
  wrapUnique(() =>
    db.prepare(`
      UPDATE verify_files
      SET host = ?, filename = ?, content = ?, note = ?, priority = ?, updated_at = ?, updated_by = ?
      WHERE id = ? AND deleted_at IS NULL
    `).run(host, filename, content, note, priority, Date.now(), userId, id)
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

// 彻底删除：仅回收站中的行可被物理删除，返回删除行数（活动行 0 行）
export function hardDeleteFile(db, id) {
  return db.prepare(
    'DELETE FROM verify_files WHERE id = ? AND deleted_at IS NOT NULL'
  ).run(id).changes;
}

export function clearTrash(db) {
  return db.prepare(
    'DELETE FROM verify_files WHERE deleted_at IS NOT NULL'
  ).run().changes;
}

// 筛选器元数据：活跃域名（含删除记录中的域名会被隐藏）与操作人。
// 操作人 = 用户列表中状态正常的用户（与「用户」页一致），不随文件记录变化。
export function listMeta(db) {
  const hosts = db.prepare(`
    SELECT DISTINCT host FROM verify_files
    WHERE deleted_at IS NULL AND host != '' AND host NOT LIKE '%*%'
    ORDER BY host ASC
  `).all().map((r) => r.host);
  return { hosts, persons: listUsers(db) };
}

// 按 filename 查候选行 → JS 过滤模式命中 → 按 compareRules 排序取第一条。
// 返回形状 {id, content} 不变，verify.js 无需改动。
export function matchFile(db, host, filename) {
  const rows = db.prepare(`
    SELECT id, host, content, priority FROM verify_files
    WHERE filename = ? AND deleted_at IS NULL
  `).all(filename)
    .map((r) => ({ ...r, host: r.host === '' ? '*' : r.host })); // 迁移残留的 '' 按全局处理
  const matched = rows
    .filter((r) => matchHost(r.host, host))
    .sort(compareRules);
  const row = matched[0];
  return row ? { id: row.id, content: row.content } : undefined;
}

// 按唯一部分索引查活动行（未删除）的 id，供导入冲突判断（skip/overwrite）用
export function findActiveByHostFilename(db, host, filename) {
  return db.prepare(`
    SELECT id FROM verify_files
    WHERE host = ? AND filename = ? AND deleted_at IS NULL
  `).get(host, filename);
}

const SORTS = {
  updated: { expr: 'f.updated_at', defaultDir: 'DESC' },
  host: { expr: 'f.host, f.filename', defaultDir: 'ASC' },
  filename: { expr: 'f.filename, f.host', defaultDir: 'ASC' },
  created: { expr: 'f.created_at', defaultDir: 'DESC' },
  created_by: { expr: 'cu.username, f.created_at', defaultDir: 'ASC' },
};

// 把用户输入里的 LIKE 通配符转义掉，让搜索按字面量匹配
function likePattern(q) {
  return `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
}

export function listFiles(db, { host, q, by, sort = 'updated', dir, includeDeleted = false, onlyGlobal = false } = {}) {
  const where = [];
  const params = [];
  if (!includeDeleted) where.push('f.deleted_at IS NULL');
  if (onlyGlobal) {
    // 只看全局记录（*）
    where.push("f.host = '*'");
  } else if (host !== undefined && host !== null && host !== '') {
    // 业务语义：列出「该域名会命中的全部规则」——SQL 取精确行 + 模式行，JS 再精确过滤
    where.push("(f.host = ? OR f.host LIKE '%*%')");
    params.push(host);
  }
  if (q) {
    where.push("(f.filename LIKE ? ESCAPE '\\' OR f.note LIKE ? ESCAPE '\\' OR f.content LIKE ? ESCAPE '\\')");
    params.push(likePattern(q), likePattern(q), likePattern(q));
  }
  if (by) {
    where.push('(f.created_by = ? OR f.updated_by = ?)');
    params.push(by, by);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const s = SORTS[sort] || SORTS.updated;
  const direction = dir === 'asc' || dir === 'desc' ? dir.toUpperCase() : s.defaultDir;
  // SQL 的方向只作用于单个表达式，多列排序（含并列次序）需逐列加上方向
  const orderBy = s.expr.split(',').map((col) => `${col} ${direction}`).join(', ');
  let rows = db.prepare(`${SELECT_WITH_USERS} ${clause} ORDER BY ${orderBy}`).all(...params);
  if (!includeDeleted && !onlyGlobal && host !== undefined && host !== null && host !== '') {
    rows = rows.filter((r) => matchHost(r.host === '' ? '*' : r.host, host));
  }
  return rows;
}
