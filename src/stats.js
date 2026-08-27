const HOUR_MS = 3600 * 1000;

function startOfDay(ms) {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

// 汇总看板数据：文件统计来自数据库（持久），请求统计来自内存环形缓冲（重启清零）。
export function computeStats(db, requestLog) {
  const total = db.prepare(
    'SELECT COUNT(*) AS n FROM verify_files WHERE deleted_at IS NULL'
  ).get().n;
  const global = db.prepare(
    "SELECT COUNT(*) AS n FROM verify_files WHERE deleted_at IS NULL AND host = '*'"
  ).get().n;
  const byDomain = db.prepare(`
    SELECT host, COUNT(*) AS count FROM verify_files
    WHERE deleted_at IS NULL AND host != '' AND host NOT LIKE '%*%'
    GROUP BY host ORDER BY count DESC, host ASC
  `).all();

  const entries = requestLog.list(); // 最新在前
  const now = Date.now();
  const todayStart = startOfDay(now);
  const today = entries.filter((e) => e.at >= todayStart);

  // 最近 24 小时按小时聚合，无请求的小时补零（旧→新）
  const curHour = Math.floor(now / HOUR_MS);
  const byHour = [];
  for (let i = 23; i >= 0; i--) {
    const hourStart = (curHour - i) * HOUR_MS;
    const count = entries.filter(
      (e) => e.at >= hourStart && e.at < hourStart + HOUR_MS
    ).length;
    byHour.push({ hour: new Date(hourStart).getHours(), count });
  }

  return {
    files: {
      total,
      bound: total - global,
      global,
      domains: byDomain.length,
      byDomain,
    },
    requests: {
      total: entries.length,
      hits: entries.filter((e) => e.hit).length,
      today: today.length,
      todayHits: today.filter((e) => e.hit).length,
      todayMisses: today.filter((e) => !e.hit).length,
      byHour,
    },
  };
}
