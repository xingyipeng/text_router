import { getBackupSettings, setBackupSettings } from './backup.js';

// 统一设置：备份（委托 backup.js）+ 会话 + 自检 + 请求记录。
// 存储沿用 settings 表（key TEXT PRIMARY KEY, value TEXT NOT NULL），支持分组局部更新。

const DEFAULTS = {
  ttl_hours: 168, // 会话有效期（小时），只影响新会话
  timeout_seconds: 8, // 自检超时（秒）
  capacity: 200, // 请求记录容量
};

const RANGES = {
  ttl_hours: [1, 720],
  timeout_seconds: [3, 30],
  capacity: [50, 5000],
};

function num(map, key, [min, max], def) {
  const n = Number(map[key]);
  return Number.isInteger(n) && n >= min && n <= max ? n : def;
}

const KEY_LIST = "'session_ttl_hours','session_single','selfcheck_timeout_seconds','requestlog_capacity'";

export function getSettings(db, overrides = {}) {
  const rows = db.prepare(`SELECT key, value FROM settings WHERE key IN (${KEY_LIST})`).all();
  const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  return {
    backup: getBackupSettings(db),
    session: {
      // 无记录时回落 config.sessionTtlHours（测试环境多为 24），再回落默认 168
      ttl_hours: map.session_ttl_hours === undefined
        ? (overrides.sessionTtlHours ?? DEFAULTS.ttl_hours)
        : num(map, 'session_ttl_hours', RANGES.ttl_hours, DEFAULTS.ttl_hours),
      single_session: map.session_single === '1',
    },
    selfcheck: {
      timeout_seconds: num(map, 'selfcheck_timeout_seconds', RANGES.timeout_seconds, DEFAULTS.timeout_seconds),
    },
    requestlog: {
      capacity: num(map, 'requestlog_capacity', RANGES.capacity, DEFAULTS.capacity),
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
        if (!Number.isInteger(ttl_hours) || ttl_hours < RANGES.ttl_hours[0] || ttl_hours > RANGES.ttl_hours[1]) {
          throw new Error('会话有效期必须是 1-720 的整数（小时）');
        }
        upsert.run('session_ttl_hours', String(ttl_hours));
      }
      if (single_session !== undefined) {
        if (typeof single_session !== 'boolean') throw new Error('单机登录必须是布尔值');
        upsert.run('session_single', single_session ? '1' : '0');
      }
    }

    if (patch.selfcheck) {
      const { timeout_seconds } = patch.selfcheck;
      if (timeout_seconds !== undefined) {
        if (!Number.isInteger(timeout_seconds) || timeout_seconds < RANGES.timeout_seconds[0] || timeout_seconds > RANGES.timeout_seconds[1]) {
          throw new Error('自检超时必须是 3-30 的整数（秒）');
        }
        upsert.run('selfcheck_timeout_seconds', String(timeout_seconds));
      }
    }

    if (patch.requestlog) {
      const { capacity } = patch.requestlog;
      if (capacity !== undefined) {
        if (!Number.isInteger(capacity) || capacity < RANGES.capacity[0] || capacity > RANGES.capacity[1]) {
          throw new Error('请求记录容量必须是 50-5000 的整数');
        }
        upsert.run('requestlog_capacity', String(capacity));
      }
    }
  })();

  return getSettings(db);
}
