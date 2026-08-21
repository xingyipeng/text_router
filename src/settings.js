import { getBackupSettings, setBackupSettings } from './backup.js';
import { SETTINGS } from './config.js';

// 统一设置：备份（委托 backup.js）+ 会话 + 自检 + 请求记录。
// 存储沿用 settings 表（key TEXT PRIMARY KEY, value TEXT NOT NULL），支持分组局部更新。
// 默认值与合法范围来自 config.js 的 SETTINGS 规格（全局参数唯一来源）。

const S = SETTINGS;
const KEY_LIST = Object.values(S)
  .flatMap((fields) => Object.values(fields).map((f) => `'${f.dbKey}'`))
  .join(',');

function num(map, key, [min, max], def) {
  const n = Number(map[key]);
  return Number.isInteger(n) && n >= min && n <= max ? n : def;
}

// env 预设的初始默认值：合法才生效，否则回落代码默认（回落语义与 num 一致）
function envDefault(raw, [min, max], fallback) {
  const n = Number(raw);
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
}

export function getSettings(db, overrides = {}) {
  const rows = db.prepare(`SELECT key, value FROM settings WHERE key IN (${KEY_LIST})`).all();
  const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  return {
    backup: getBackupSettings(db, overrides.backup),
    session: {
      // 无记录时回落部署级 config.sessionTtlHours（测试环境多为 24），再回落默认 168
      ttl_hours: map[S.session.ttl_hours.dbKey] === undefined
        ? (overrides.session?.ttl_hours ?? S.session.ttl_hours.default)
        : num(map, S.session.ttl_hours.dbKey, S.session.ttl_hours.range,
            envDefault(overrides.session?.ttl_hours, S.session.ttl_hours.range, S.session.ttl_hours.default)),
      single_session: map[S.session.single_session.dbKey] === '1',
    },
    selfcheck: {
      timeout_seconds: num(map, S.selfcheck.timeout_seconds.dbKey, S.selfcheck.timeout_seconds.range,
        envDefault(overrides.selfcheck?.timeout_seconds, S.selfcheck.timeout_seconds.range, S.selfcheck.timeout_seconds.default)),
    },
    requestlog: {
      capacity: num(map, S.requestlog.capacity.dbKey, S.requestlog.capacity.range,
        envDefault(overrides.requestlog?.capacity, S.requestlog.capacity.range, S.requestlog.capacity.default)),
    },
  };
}

// 分组局部更新：只改 patch 里出现的组/键。校验错误抛中文 Error，由路由转 400。
export function setSettings(db, patch) {
  const upsert = db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `);

  db.transaction(() => {
    if (patch.backup) setBackupSettings(db, patch.backup);

    if (patch.session) {
      const { ttl_hours, single_session } = patch.session;
      if (ttl_hours !== undefined) {
        const [min, max] = S.session.ttl_hours.range;
        if (!Number.isInteger(ttl_hours) || ttl_hours < min || ttl_hours > max) {
          throw new Error(`会话有效期必须是 ${min}-${max} 的整数（小时）`);
        }
        upsert.run(S.session.ttl_hours.dbKey, String(ttl_hours));
      }
      if (single_session !== undefined) {
        if (typeof single_session !== 'boolean') throw new Error('单机登录必须是布尔值');
        upsert.run(S.session.single_session.dbKey, single_session ? '1' : '0');
      }
    }

    if (patch.selfcheck) {
      const { timeout_seconds } = patch.selfcheck;
      if (timeout_seconds !== undefined) {
        const [min, max] = S.selfcheck.timeout_seconds.range;
        if (!Number.isInteger(timeout_seconds) || timeout_seconds < min || timeout_seconds > max) {
          throw new Error(`自检超时必须是 ${min}-${max} 的整数（秒）`);
        }
        upsert.run(S.selfcheck.timeout_seconds.dbKey, String(timeout_seconds));
      }
    }

    if (patch.requestlog) {
      const { capacity } = patch.requestlog;
      if (capacity !== undefined) {
        const [min, max] = S.requestlog.capacity.range;
        if (!Number.isInteger(capacity) || capacity < min || capacity > max) {
          throw new Error(`请求记录容量必须是 ${min}-${max} 的整数`);
        }
        upsert.run(S.requestlog.capacity.dbKey, String(capacity));
      }
    }
  })();

  return getSettings(db);
}
