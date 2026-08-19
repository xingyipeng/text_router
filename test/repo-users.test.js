import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db.js';
import { UniqueViolation } from '../src/repo/errors.js';
import { verifyPassword } from '../src/password.js';
import {
  createUser, getUser, findActiveByUsername, listUsers,
  disableUser, restoreUser, setPassword, countUsers,
} from '../src/repo/users.js';

let dir, db;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wxr-'));
  db = openDb(join(dir, 'test.db'));
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('createUser', () => {
  it('创建后可查到，且不返回 password_hash', () => {
    const u = createUser(db, { username: 'alice', password: 'password1234', displayName: 'Alice' });
    expect(u.id).toBeGreaterThan(0);
    expect(u.username).toBe('alice');
    expect(u.password_hash).toBeUndefined();
  });

  it('密码被哈希存储', () => {
    createUser(db, { username: 'alice', password: 'password1234' });
    const row = findActiveByUsername(db, 'alice');
    expect(row.password_hash).not.toBe('password1234');
    expect(verifyPassword('password1234', row.password_hash)).toBe(true);
  });

  it('同名启用用户重复时抛 UniqueViolation', () => {
    createUser(db, { username: 'alice', password: 'password1234' });
    expect(() => createUser(db, { username: 'alice', password: 'password5678' }))
      .toThrow(UniqueViolation);
  });

  it('isSuper 存为 1', () => {
    const u = createUser(db, { username: 'root', password: 'password1234', isSuper: true });
    expect(u.is_super).toBe(1);
  });
});

describe('disableUser', () => {
  it('禁用后 findActiveByUsername 查不到', () => {
    const u = createUser(db, { username: 'alice', password: 'password1234' });
    disableUser(db, u.id);
    expect(findActiveByUsername(db, 'alice')).toBeUndefined();
  });

  it('禁用会连带删除该用户的所有会话', () => {
    const u = createUser(db, { username: 'alice', password: 'password1234' });
    db.prepare('INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?,?,?,?)')
      .run('tok', u.id, Date.now(), Date.now() + 100000);
    disableUser(db, u.id);
    expect(db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n).toBe(0);
  });

  it('禁用后可以创建同名新用户', () => {
    const u = createUser(db, { username: 'alice', password: 'password1234' });
    disableUser(db, u.id);
    expect(() => createUser(db, { username: 'alice', password: 'password5678' })).not.toThrow();
  });
});

describe('restoreUser', () => {
  it('恢复后可再次查到', () => {
    const u = createUser(db, { username: 'alice', password: 'password1234' });
    disableUser(db, u.id);
    restoreUser(db, u.id);
    expect(findActiveByUsername(db, 'alice')).toBeDefined();
  });

  it('同名启用账号已存在时抛 UniqueViolation', () => {
    const u = createUser(db, { username: 'alice', password: 'password1234' });
    disableUser(db, u.id);
    createUser(db, { username: 'alice', password: 'password5678' });
    expect(() => restoreUser(db, u.id)).toThrow(UniqueViolation);
  });
});

describe('setPassword', () => {
  it('改密后新密码生效、旧密码失效', () => {
    const u = createUser(db, { username: 'alice', password: 'password1234' });
    setPassword(db, u.id, 'newpassword9999');
    const row = findActiveByUsername(db, 'alice');
    expect(verifyPassword('newpassword9999', row.password_hash)).toBe(true);
    expect(verifyPassword('password1234', row.password_hash)).toBe(false);
  });

  it('改密会清除该用户的所有会话', () => {
    const u = createUser(db, { username: 'alice', password: 'password1234' });
    db.prepare('INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?,?,?,?)')
      .run('tok', u.id, Date.now(), Date.now() + 100000);
    setPassword(db, u.id, 'newpassword9999');
    expect(db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n).toBe(0);
  });
});

describe('listUsers / countUsers', () => {
  it('默认不含已禁用用户，includeDisabled 时包含', () => {
    const a = createUser(db, { username: 'alice', password: 'password1234' });
    createUser(db, { username: 'bob', password: 'password1234' });
    disableUser(db, a.id);
    expect(listUsers(db)).toHaveLength(1);
    expect(listUsers(db, { includeDisabled: true })).toHaveLength(2);
  });

  it('countUsers 统计所有用户，含已禁用', () => {
    expect(countUsers(db)).toBe(0);
    const a = createUser(db, { username: 'alice', password: 'password1234' });
    disableUser(db, a.id);
    expect(countUsers(db)).toBe(1);
  });

  it('getUser 不返回 password_hash', () => {
    const u = createUser(db, { username: 'alice', password: 'password1234' });
    expect(getUser(db, u.id).password_hash).toBeUndefined();
  });
});
