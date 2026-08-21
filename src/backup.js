import Database from 'better-sqlite3';
import {
  mkdirSync, readdirSync, renameSync, statSync, unlinkSync,
  existsSync, copyFileSync,
} from 'node:fs';
import { join, basename } from 'node:path';

// 备份管理核心：CLI（scripts/backup.js）与 HTTP 路由共用。
// 备份用 better-sqlite3 在线备份 API，运行中的服务无需停机、快照一致。

// 新备份用 text_router- 前缀；旧前缀 wx_router- 仍可识别，保证老部署的存量备份在界面照常列表/恢复/删除
export const BACKUP_NAME_RE = /^(?:wx_router|text_router)-\d{8}-\d{6}(-\d+)?\.db$/;

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// 保留最近 keep 份，其余删除。返回被清理的文件名列表。
// 按 mtime 排序而非文件名：同秒冲突产生的 -N 后缀名在字典序上反而不如
// 无后缀名靠后，字典序会误删新建的备份。
export function pruneBackups(dir, keep) {
  if (!existsSync(dir)) return [];
  const backups = readdirSync(dir)
    .filter((f) => BACKUP_NAME_RE.test(f))
    .map((name) => ({ name, mtimeMs: statSync(join(dir, name)).mtimeMs }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs || (a.name < b.name ? 1 : -1)); // 新→旧
  const old = backups.slice(keep).map((b) => b.name);
  for (const f of old) {
    try { unlinkSync(join(dir, f)); } catch {}
  }
  return old;
}

// 对运行中的库做一致性在线备份，产出单文件（journal_mode=delete，无 -wal/-shm 伴生文件）。
export async function runBackup(db, dir, keep) {
  mkdirSync(dir, { recursive: true });

  const base = join(dir, `text_router-${stamp()}`);
  let finalPath = `${base}.db`;
  let n = 1;
  while (existsSync(finalPath)) finalPath = `${base}-${n++}.db`;
  const tmpPath = `${finalPath}.tmp`;

  try {
    await db.backup(tmpPath); // 在线备份 API：服务正在写入也能拿到一致快照

    // 备份副本切回 delete 模式：WAL 内容合并进主文件，伴生文件随之清理
    const dest = new Database(tmpPath);
    dest.pragma('journal_mode = delete');
    const result = dest.pragma('integrity_check', { simple: true });
    dest.close();
    if (result !== 'ok') throw new Error(`完整性校验失败：${result}`);
    // 保险：切换模式后如仍残留空伴生文件，清掉保证备份是单文件
    for (const side of [`${tmpPath}-wal`, `${tmpPath}-shm`]) {
      if (existsSync(side)) { try { unlinkSync(side); } catch {} }
    }

    renameSync(tmpPath, finalPath);
  } catch (err) {
    if (existsSync(tmpPath)) { try { unlinkSync(tmpPath); } catch {} }
    throw err;
  }

  const pruned = pruneBackups(dir, keep);
  return {
    filename: basename(finalPath),
    sizeKb: +(statSync(finalPath).size / 1024).toFixed(1),
    pruned,
  };
}

export function listBackups(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => BACKUP_NAME_RE.test(f))
    .map((name) => {
      const st = statSync(join(dir, name));
      return { name, size: st.size, mtimeMs: st.mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs || (a.name < b.name ? 1 : -1)); // 新→旧
}

export function deleteBackup(dir, name) {
  if (!BACKUP_NAME_RE.test(name)) throw new Error('非法的备份文件名');
  const p = join(dir, name);
  if (!existsSync(p)) throw new Error('备份不存在');
  unlinkSync(p);
}

// —— 定时备份设置（存 settings 表）——

const DEFAULT_SETTINGS = { enabled: false, time: '03:17', keep: 14 };

export function getBackupSettings(db) {
  const rows = db.prepare(`SELECT key, value FROM settings WHERE key LIKE 'backup_%'`).all();
  const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  return {
    enabled: map.backup_enabled === '1',
    time: /^([01]\d|2[0-3]):[0-5]\d$/.test(map.backup_time || '') ? map.backup_time : DEFAULT_SETTINGS.time,
    keep: Number.isInteger(Number(map.backup_keep)) && Number(map.backup_keep) >= 1
      ? Number(map.backup_keep) : DEFAULT_SETTINGS.keep,
  };
}

export function setBackupSettings(db, { enabled, time, keep }) {
  if (typeof enabled !== 'boolean') throw new Error('enabled 必须是布尔值');
  if (typeof time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) {
    throw new Error('time 必须是 HH:MM 格式');
  }
  if (!Number.isInteger(keep) || keep < 1 || keep > 1000) {
    throw new Error('keep 必须是 1-1000 的整数');
  }
  const upsert = db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `);
  db.transaction(() => {
    upsert.run('backup_enabled', enabled ? '1' : '0');
    upsert.run('backup_time', time);
    upsert.run('backup_keep', String(keep));
  })();
  return { enabled, time, keep };
}

// —— 定时备份调度 ——
// state.lastRunMinute 在内存中：同一分钟只跑一次，防止 60s tick 与慢备份叠加重复执行。

export async function maybeRunScheduledBackup({ db, dir, state }, now = new Date()) {
  const settings = getBackupSettings(db);
  if (!settings.enabled) return { ran: false };

  const p = (x) => String(x).padStart(2, '0');
  const minute = `${p(now.getHours())}:${p(now.getMinutes())}`;
  if (minute !== settings.time) return { ran: false };
  if (state.lastRunMinute === minute) return { ran: false };

  try {
    const result = await runBackup(db, dir, settings.keep);
    state.lastRunMinute = minute;
    return { ran: true, ...result };
  } catch (err) {
    console.error(`[backup] 定时备份失败：${err.message}`);
    return { ran: false };
  }
}

// 返回 stop 函数。启动时先检查一次，提高恰好落在设定分钟内的命中率。
export function startBackupScheduler({ db, dir, state = {}, intervalMs = 60000 }) {
  const tick = async () => {
    const r = await maybeRunScheduledBackup({ db, dir, state });
    if (r.ran) console.log(`[backup] 定时备份完成：${r.filename}（${r.sizeKb} KB）`);
  };
  tick();
  const timer = setInterval(tick, intervalMs);
  return () => clearInterval(timer);
}

// —— 恢复 ——
// restoreBackup：校验备份名/存在性/完整性后调用 replaceDbFile。
// replaceDbFile：关闭连接 → 旧库留底 .before-restore → 用 srcPath 替换库文件，失败尽力回滚。
// 调用方负责在响应发出后重启进程。db 关闭之后绝不再触碰。

export function restoreBackup({ db, dbPath, dir, name }) {
  if (!BACKUP_NAME_RE.test(name)) throw new Error('非法的备份文件名');
  const backupPath = join(dir, name);
  if (!existsSync(backupPath)) throw new Error('备份文件不存在');
  if (!existsSync(dbPath)) throw new Error('数据库文件不存在');

  const chk = new Database(backupPath, { readonly: true, fileMustExist: true });
  const ok = chk.pragma('integrity_check', { simple: true });
  chk.close();
  if (ok !== 'ok') throw new Error(`备份完整性校验失败：${ok}`);

  return replaceDbFile({ db, dbPath, srcPath: backupPath });
}

// 把库文件替换为 srcPath 指向的文件（须已通过完整性校验）。返回留底路径。
export function replaceDbFile({ db, dbPath, srcPath }) {
  db.close();

  const beforePath = `${dbPath}.before-restore`;
  const tmpPath = `${dbPath}.tmp-restore`;
  try {
    if (existsSync(beforePath)) unlinkSync(beforePath); // 覆盖上次恢复留下的旧底
    renameSync(dbPath, beforePath);
    for (const ext of ['-wal', '-shm']) { // 清掉旧库的 WAL 残留，防止污染新库
      const side = dbPath + ext;
      if (existsSync(side)) unlinkSync(side);
    }
    copyFileSync(srcPath, tmpPath);
    renameSync(tmpPath, dbPath);
  } catch (err) {
    // 尽力回滚：把留底放回去
    try { if (existsSync(tmpPath)) unlinkSync(tmpPath); } catch {}
    try { if (existsSync(beforePath) && !existsSync(dbPath)) renameSync(beforePath, dbPath); } catch {}
    throw err;
  }
  return { beforeRestore: beforePath };
}
