// 全局参数配置唯一来源：所有 env 名、默认值、合法范围都集中在这里。
// server.js 读部署级配置；settings.js / backup.js 取运行级设置的默认值与范围。
// 新增/修改参数只动这一个文件（文档 .env.example / README 需手动同步）。

// —— 超管初始账号（仅数据库为空时创建）——
export const DEFAULT_SUPER_USER = 'admin';
export const DEFAULT_SUPER_PASSWORD = 'admin123';

// —— 部署级配置（env，代码默认兜底；改完需重启）——
// parse 存在时对 env 原始值做类型转换（转换失败的值如 NaN 由使用方兜底）
export const DEPLOY = {
    port: {env: 'PORT', default: 3000, parse: Number},
    dataDir: {env: 'DATA_DIR', default: './data'},
    backupDir: {env: 'BACKUP_DIR', default: './backups'},
    sessionTtlHours: {env: 'SESSION_TTL_HOURS', default: 168, parse: Number},
    cookieSecure: {env: 'COOKIE_SECURE', default: false, parse: (v) => v === 'true'},
    docsDir: {env: 'DOCS_DIR', default: './docs'},
    superAdminUser: {env: 'SUPER_ADMIN_USER', default: DEFAULT_SUPER_USER},
    superAdminPassword: {env: 'SUPER_ADMIN_PASSWORD', default: DEFAULT_SUPER_PASSWORD},
};

// —— 运行级设置（DB 存储、管理界面可改；env 只提供 DB 无记录时的初始默认值）——
// 字段规格：dbKey（settings 表 key）、default（代码默认）、
// range（数字范围 [min, max]）或 pattern（正则校验，二选一）、envPreset（初始默认值的 env 名，可选）
export const SETTINGS = {
    session: {
        ttl_hours: {dbKey: 'session_ttl_hours', default: 168, range: [1, 720]},
        single_session: {dbKey: 'session_single', default: false},
    },
    selfcheck: {
        timeout_seconds: {
            dbKey: 'selfcheck_timeout_seconds',
            default: 8,
            range: [3, 30],
            envPreset: 'SELFCHECK_TIMEOUT_SECONDS'
        },
    },
    requestlog: {
        capacity: {dbKey: 'requestlog_capacity', default: 2000, range: [50, 5000], envPreset: 'REQUESTLOG_CAPACITY'},
    },
    backup: {
        enabled: {dbKey: 'backup_enabled', default: false, envPreset: 'BACKUP_ENABLED'},
        time: {dbKey: 'backup_time', default: '23:00', pattern: /^([01]\d|2[0-3]):[0-5]\d$/, envPreset: 'BACKUP_TIME'},
        keep: {dbKey: 'backup_keep', default: 7, range: [1, 1000], envPreset: 'BACKUP_KEEP'},
    },
};

// 读部署级配置：env 存在用 env（parse 转换），否则代码默认
export function deployConfig() {
    const out = {};
    for (const [key, {env, default: def, parse}] of Object.entries(DEPLOY)) {
        const raw = process.env[env];
        out[key] = raw === undefined ? def : (parse ? parse(raw) : raw);
    }
    return out;
}

// 提取运行级设置的 env 初始默认值（原始值，合法性校验在 settings.js / backup.js）
export function envPresets() {
    const out = {};
    for (const [group, fields] of Object.entries(SETTINGS)) {
        for (const [name, spec] of Object.entries(fields)) {
            if (!spec.envPreset) continue;
            out[group] ??= {};
            out[group][name] = process.env[spec.envPreset];
        }
    }
    return out;
}
