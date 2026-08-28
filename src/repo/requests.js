// 请求日志持久化：SQLite 表（有界，超出容量删最旧），请求记录页分页查询。
// 看板实时统计仍走内存环形缓冲（requestlog.js），两处写入、各司其职。

// 表结构在 db.js 的 SCHEMA 里（openDb 自动建表），本模块只做读写。

const COLUMNS = `id, at, host, forwarded_host, resolved_host, path, filename,
  scheme, method, ua, ip, remote_ip, hit, file_id`;

const INSERT = `
  INSERT INTO requests
    (at, host, forwarded_host, resolved_host, path, filename, scheme, method, ua, ip, remote_ip, hit, file_id)
  VALUES (@at, @host, @forwardedHost, @resolvedHost, @path, @filename, @scheme, @method, @ua, @ip, @remoteIp, @hit, @fileId)
`;

const rowToEntry = (r) => ({
  id: r.id,
  at: r.at,
  host: r.host,
  forwardedHost: r.forwarded_host,
  resolvedHost: r.resolved_host,
  path: r.path,
  filename: r.filename,
  scheme: r.scheme,
  method: r.method,
  ua: r.ua,
  ip: r.ip,
  remoteIp: r.remote_ip,
  hit: Boolean(r.hit),
  fileId: r.file_id ?? null,
});

export function insertRequest(db, entry) {
  db.prepare(INSERT).run({
    at: entry.at,
    host: entry.host || '',
    forwardedHost: entry.forwardedHost || '',
    resolvedHost: entry.resolvedHost || '',
    path: entry.path || '',
    filename: entry.filename || '',
    scheme: entry.scheme || '',
    method: entry.method || '',
    ua: entry.ua || '',
    ip: entry.ip || '',
    remoteIp: entry.remoteIp || '',
    hit: entry.hit ? 1 : 0,
    fileId: entry.fileId ?? null,
  });
}

export function countRequests(db) {
  return db.prepare('SELECT COUNT(*) AS n FROM requests').get().n;
}

// 超出容量删最旧（id 升序 = 时间升序，保留最新 cap 条）
export function trimRequests(db, cap) {
  db.prepare(
    'DELETE FROM requests WHERE id NOT IN (SELECT id FROM requests ORDER BY id DESC LIMIT ?)'
  ).run(cap);
}

export function clearRequests(db) {
  db.prepare('DELETE FROM requests').run();
}

// 分页查询：beforeId 缺省取最新一页；返回 { rows, hasMore, total }
export function listRequests(db, { beforeId, limit } = {}) {
  const n = Math.min(Math.max(Number(limit) || 200, 1), 500);
  const rows = (beforeId === undefined
    ? db.prepare(`SELECT ${COLUMNS} FROM requests ORDER BY id DESC LIMIT ?`).all(n)
    : db.prepare(`SELECT ${COLUMNS} FROM requests WHERE id < ? ORDER BY id DESC LIMIT ?`).all(beforeId, n)
  ).map(rowToEntry);

  const total = countRequests(db);
  const oldestId = rows.length ? rows[rows.length - 1].id : null;
  const hasMore = oldestId !== null &&
    db.prepare('SELECT 1 FROM requests WHERE id < ? LIMIT 1').get(oldestId) !== undefined;

  return { rows, total, hasMore };
}
