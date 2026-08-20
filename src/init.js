import { countUsers, createUser } from './repo/users.js';
import { MIN_PASSWORD_LENGTH } from './validate.js';
import { hashPassword } from './password.js';

export const DEFAULT_SUPER_USER = 'admin';
export const DEFAULT_SUPER_PASSWORD = 'admin123';

export function ensureSuperAdmin(db, { username, password } = {}) {
  if (countUsers(db) > 0) return { created: false };

  const defaultedUsername = !username;
  const defaultedPassword = !password;
  const finalUsername = username || DEFAULT_SUPER_USER;
  const finalPassword = password || DEFAULT_SUPER_PASSWORD;

  // 默认密码 admin123 恰好满足 8 位下限；显式设置的密码同样受此约束
  if (finalPassword.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`SUPER_ADMIN_PASSWORD 至少需要 ${MIN_PASSWORD_LENGTH} 个字符`);
  }

  createUser(db, {
    username: finalUsername, password: finalPassword,
    displayName: finalUsername, isSuper: true, createdBy: null,
  });
  return { created: true, username: finalUsername, defaultedUsername, defaultedPassword };
}

export function resetSuperPassword(db, newPassword) {
  if (typeof newPassword !== 'string' || newPassword.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`新密码至少需要 ${MIN_PASSWORD_LENGTH} 个字符`);
  }

  const su = db.prepare('SELECT id, username FROM users WHERE is_super = 1 ORDER BY id LIMIT 1').get();
  if (!su) throw new Error('未找到超级管理员，数据库可能已损坏');

  db.transaction(() => {
    db.prepare('UPDATE users SET password_hash = ?, disabled_at = NULL WHERE id = ?')
      .run(hashPassword(newPassword), su.id);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(su.id);
  })();

  return { id: su.id, username: su.username };
}
