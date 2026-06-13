// AES-256-GCM encryption for secrets at rest (Google OAuth refresh tokens).
// The key is derived from JWT_SECRET so no extra config is needed; swap to a
// dedicated KMS data key for stronger separation in production.
import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';

const KEY = createHash('sha256').update(process.env.JWT_SECRET || 'dev-secret-change-me').digest(); // 32 bytes
const PREFIX = 'enc:';

export function encrypt(plain) {
  if (plain == null || plain === '') return plain;
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', KEY, iv);
  const enc = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return PREFIX + Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64');
}

export function decrypt(val) {
  if (typeof val !== 'string' || !val.startsWith(PREFIX)) return val; // plaintext / legacy
  try {
    const buf = Buffer.from(val.slice(PREFIX.length), 'base64');
    const d = createDecipheriv('aes-256-gcm', KEY, buf.subarray(0, 12));
    d.setAuthTag(buf.subarray(12, 28));
    return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8');
  } catch {
    return '';
  }
}
