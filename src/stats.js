const HOUR_MS = 3600 * 1000;

// 双段公共后缀（如 com.cn）取三段主域，其余取最后两段；可按需扩展
const MULTI_LABEL_SUFFIXES = new Set(['com.cn', 'net.cn', 'org.cn', 'gov.cn', 'edu.cn', 'ac.cn']);

// 从规则域名提取主域名：剥掉 * / ** 通配标签后取注册域；纯通配无法归类返回空串
export function mainDomain(host) {
  const labels = host.split('.').filter((l) => l !== '*' && l !== '**');
  if (!labels.length) return '';
  const n = MULTI_LABEL_SUFFIXES.has(labels.slice(-2).join('.')) ? 3 : 2;
  return labels.slice(-n).join('.');
}

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
  const hostRows = db.prepare(`
    SELECT host, COUNT(*) AS count FROM verify_files
    WHERE deleted_at IS NULL AND host != '' AND host != '*'
    GROUP BY host
  `).all();

  // 按规则统计：域名按原样分组（含通配模式），一条不隐藏
  const byRuleHost = hostRows
    .map(({ host, count }) => ({ host, count }))
    .sort((a, b) => b.count - a.count || a.host.localeCompare(b.host));

  // 按主域名统计：通配标签剥掉后聚合（wx-router.saitron-m.com 并入 saitron-m.com）
  const main = new Map();
  for (const { host, count } of hostRows) {
    const m = mainDomain(host);
    if (m) main.set(m, (main.get(m) || 0) + count);
  }
  const byMainDomain = [...main.entries()]
    .map(([host, count]) => ({ host, count }))
    .sort((a, b) => b.count - a.count || a.host.localeCompare(b.host));

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
      domains: byMainDomain.length,
      byMainDomain,
      byRuleHost,
    },
    requests: {
      total: entries.length,
      hits: entries.filter((e) => e.hit).length,
      today: today.length,
      todayHits: today.filter((e) => e.hit).length,
      todayMisses: today.filter((e) => !e.hit).length,
      byHour,
      // 看板底部预览：最新 5 条，拼成完整 URL（完整记录在请求记录页）
      recent: entries.slice(0, 5).map((e) => ({
        at: e.at,
        url: `${e.scheme || 'http'}://${e.resolvedHost || e.host}${e.path}`,
        hit: e.hit,
      })),
    },
  };
}
