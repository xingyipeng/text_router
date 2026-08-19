import { describe, it, expect } from 'vitest';
import { hashPassword, verifyPassword } from '../src/password.js';

describe('password', () => {
  it('哈希格式是 salt:hash 的 hex', () => {
    const stored = hashPassword('correct-horse-battery');
    expect(stored).toMatch(/^[0-9a-f]{32}:[0-9a-f]{128}$/);
  });

  it('相同密码两次哈希结果不同（salt 随机）', () => {
    expect(hashPassword('same-password-x')).not.toBe(hashPassword('same-password-x'));
  });

  it('正确密码校验通过', () => {
    const stored = hashPassword('correct-horse-battery');
    expect(verifyPassword('correct-horse-battery', stored)).toBe(true);
  });

  it('错误密码校验失败', () => {
    const stored = hashPassword('correct-horse-battery');
    expect(verifyPassword('wrong-password-here', stored)).toBe(false);
  });

  it('畸形存储值不抛异常，返回 false', () => {
    expect(verifyPassword('any-password-x', 'garbage')).toBe(false);
    expect(verifyPassword('any-password-x', '')).toBe(false);
    expect(verifyPassword('any-password-x', 'zz:zz')).toBe(false);
    expect(verifyPassword('any-password-x', null)).toBe(false);
  });
});
