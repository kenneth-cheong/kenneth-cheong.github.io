// Password hashing for email/password sign-in. Uses Node's built-in scrypt
// (no native deps — bcrypt would break the esbuild→Lambda bundle) with a random
// per-password salt and a constant-time compare. Stored format is a single
// self-describing string:  scrypt$<N>$<saltB64>$<hashB64>
import { scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';

const N = 16384; // CPU/memory cost (2^14) — a sensible Lambda-friendly default.
const KEYLEN = 32;
const PREFIX = 'scrypt';

/** Minimum acceptable password length (also enforced at the API boundary). */
export const MIN_PASSWORD_LEN = 8;
export const MAX_PASSWORD_LEN = 200;

/** True if `pw` is a string within the allowed length bounds. */
export function isValidPassword(pw) {
  return typeof pw === 'string' && pw.length >= MIN_PASSWORD_LEN && pw.length <= MAX_PASSWORD_LEN;
}

export function hashPassword(plain) {
  const salt = randomBytes(16);
  const hash = scryptSync(String(plain), salt, KEYLEN, { N });
  return [PREFIX, N, salt.toString('base64'), hash.toString('base64')].join('$');
}

/** Constant-time verify. Returns false for any malformed/missing stored value. */
export function verifyPassword(plain, stored) {
  if (typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== PREFIX) return false;
  const cost = Number(parts[1]);
  if (!Number.isInteger(cost) || cost < 2) return false;
  let salt, expected;
  try {
    salt = Buffer.from(parts[2], 'base64');
    expected = Buffer.from(parts[3], 'base64');
  } catch {
    return false;
  }
  if (!salt.length || !expected.length) return false;
  let actual;
  try {
    actual = scryptSync(String(plain), salt, expected.length, { N: cost });
  } catch {
    return false;
  }
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
