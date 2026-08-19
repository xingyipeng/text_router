import { countUsers, createUser } from './repo/users.js';
import { MIN_PASSWORD_LENGTH } from './validate.js';
import { hashPassword } from './password.js';

export function ensureSuperAdmin(db, { username, password } = {}) {
  if (countUsers(db) > 0) return { created: false };

  if (!username) {
    throw new Error('数据库为空但未设置 SUPER_ADMIN_USER，拒绝以无人可登录的状态启动');
  }
  if (!password) {
    throw new Error('数据库为空但未设置 SUPER_ADMIN_PASSWORD，拒绝以无人可登录的状态启动');
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`SUPER_ADMIN_PASSWORD 至少需要 ${MIN_PASSWORD_LENGTH} 个字符`);
  }

  createUser(db, {
    username, password, displayName: username, isSuper: true, createdBy: null,
  });
  return { created: true };
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
