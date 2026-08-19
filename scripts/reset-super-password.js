import { join } from 'node:path';
import { openDb } from '../src/db.js';
import { resetSuperPassword } from '../src/init.js';

const newPassword = process.argv[2];
if (!newPassword) {
  console.error('用法：node scripts/reset-super-password.js <新密码>');
  process.exit(1);
}

const dataDir = process.env.DATA_DIR || './data';
const db = openDb(join(dataDir, 'wx_router.db'));

try {
  const su = resetSuperPassword(db, newPassword);
  console.log(`已重置超级管理员 ${su.username} 的密码，并清除其全部会话。`);
} catch (err) {
  console.error(`失败：${err.message}`);
  process.exitCode = 1;
} finally {
  db.close();
}
