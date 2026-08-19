import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const SALT_BYTES = 16;
const KEY_BYTES = 64;

export function hashPassword(password) {
  const salt = randomBytes(SALT_BYTES);
  const key = scryptSync(password, salt, KEY_BYTES);
  return `${salt.toString('hex')}:${key.toString('hex')}`;
}

export function verifyPassword(password, stored) {
  if (typeof stored !== 'string') return false;
  const parts = stored.split(':');
  if (parts.length !== 2) return false;
  const [saltHex, keyHex] = parts;
  if (!/^[0-9a-f]+$/.test(saltHex) || !/^[0-9a-f]+$/.test(keyHex)) return false;

  const expected = Buffer.from(keyHex, 'hex');
  if (expected.length !== KEY_BYTES) return false;

  const actual = scryptSync(password, Buffer.from(saltHex, 'hex'), KEY_BYTES);
  return timingSafeEqual(actual, expected);
}
