import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db.js';
import { createUser, disableUser } from '../src/repo/users.js';
import { createSession, getSessionUser, deleteSession } from '../src/repo/sessions.js';

let dir, db, user;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wxr-'));
  db = openDb(join(dir, 'test.db'));
  user = createUser(db, { username: 'alice', password: 'password1234', displayName: 'Alice' });
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('createSession', () => {
  it('返回 64 位 hex token', () => {
    expect(createSession(db, user.id, 1)).toMatch(/^[0-9a-f]{64}$/);
  });
  it('两次调用 token 不同', () => {
    expect(createSession(db, user.id, 1)).not.toBe(createSession(db, user.id, 1));
  });
});

describe('getSessionUser', () => {
  it('有效 token 返回用户，且不含 password_hash', () => {
    const token = createSession(db, user.id, 1);
    const u = getSessionUser(db, token);
    expect(u.username).toBe('alice');
    expect(u.password_hash).toBeUndefined();
  });

  it('无效 token 返回 undefined', () => {
    expect(getSessionUser(db, 'nope')).toBeUndefined();
    expect(getSessionUser(db, '')).toBeUndefined();
    expect(getSessionUser(db, null)).toBeUndefined();
  });

  it('过期 token 返回 undefined', () => {
    const token = createSession(db, user.id, 1);
    db.prepare('UPDATE sessions SET expires_at = ? WHERE token = ?').run(Date.now() - 1000, token);
    expect(getSessionUser(db, token)).toBeUndefined();
  });

  it('惰性清理已过期会话', () => {
    const token = createSession(db, user.id, 1);
    db.prepare('UPDATE sessions SET expires_at = ? WHERE token = ?').run(Date.now() - 1000, token);
    getSessionUser(db, 'anything');
    expect(db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n).toBe(0);
  });

  it('用户被禁用后其 token 立即失效', () => {
    const token = createSession(db, user.id, 1);
    disableUser(db, user.id);
    expect(getSessionUser(db, token)).toBeUndefined();
  });
});

describe('deleteSession', () => {
  it('删除后 token 失效', () => {
    const token = createSession(db, user.id, 1);
    deleteSession(db, token);
    expect(getSessionUser(db, token)).toBeUndefined();
  });
});
