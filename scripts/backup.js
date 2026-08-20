import { existsSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { runBackup } from '../src/backup.js';

// CLI 薄壳：备份核心在 src/backup.js，与界面里的「立即备份」共用同一套逻辑。
// 用法：node scripts/backup.js [--dir 备份目录] [--keep 保留份数] [--data-dir 数据目录]
// 环境变量：BACKUP_DIR、KEEP、DATA_DIR（命令行参数优先）

const usage = `用法：node scripts/backup.js [--dir 备份目录] [--keep 保留份数] [--data-dir 数据目录]

对运行中的数据库做一致性在线备份（SQLite backup API），无需停机。
每份备份命名为 wx_router-YYYYMMDD-HHMMSS.db，写完后校验完整性再原子改名，
并只保留最近 --keep 份（默认 14）。

示例：
  node scripts/backup.js --dir ./backups --keep 14
  docker compose exec -T wx_router node scripts/backup.js --dir /app/data/backups --keep 30`;

function parseArgs(argv) {
  const opts = {
    dir: process.env.BACKUP_DIR || './backups',
    keep: Number(process.env.KEEP) || 14,
    dataDir: process.env.DATA_DIR || './data',
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`${a} 缺少参数`);
      return argv[++i];
    };
    if (a === '--dir') opts.dir = next();
    else if (a === '--keep') opts.keep = Number(next());
    else if (a === '--data-dir') opts.dataDir = next();
    else if (a === '-h' || a === '--help') { console.log(usage); process.exit(0); }
    else throw new Error(`未知参数：${a}（-h 查看用法）`);
  }
  if (!Number.isInteger(opts.keep) || opts.keep < 1) throw new Error('--keep 必须是正整数');
  return opts;
}

const opts = parseArgs(process.argv.slice(2));
const dbPath = join(opts.dataDir, 'wx_router.db');
if (!existsSync(dbPath)) {
  console.error(`失败：找不到数据库文件 ${dbPath}`);
  process.exit(1);
}

try {
  // 只读打开源库：备份脚本绝不写运行中的库，也不触碰它的 WAL
  const src = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const r = await runBackup(src, opts.dir, opts.keep);
    console.log(`已备份 ${join(opts.dir, r.filename)}（${r.sizeKb} KB，integrity_check: ok）`);
    for (const f of r.pruned) console.log(`已清理过期备份 ${f}`);
  } finally {
    src.close();
  }
} catch (err) {
  console.error(`失败：${err.message}`);
  process.exitCode = 1;
}
