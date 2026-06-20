import { describe, it, expect } from 'vitest';
import { hashPassword, verifyPassword, isValidPassword } from '../src/lib/password.mjs';

describe('password', () => {
  it('verifies a correct password', () => {
    const h = hashPassword('correct horse battery staple');
    expect(verifyPassword('correct horse battery staple', h)).toBe(true);
  });

  it('rejects a wrong password', () => {
    const h = hashPassword('s3cret-pw');
    expect(verifyPassword('s3cret-pX', h)).toBe(false);
  });

  it('uses a random salt — same password hashes differently each time', () => {
    expect(hashPassword('repeatme')).not.toBe(hashPassword('repeatme'));
  });

  it('returns false for malformed / missing stored hashes', () => {
    expect(verifyPassword('x', null)).toBe(false);
    expect(verifyPassword('x', '')).toBe(false);
    expect(verifyPassword('x', 'not-a-hash')).toBe(false);
    expect(verifyPassword('x', 'scrypt$16384$onlythree')).toBe(false);
    expect(verifyPassword('x', 'bcrypt$16384$abc$def')).toBe(false);
  });

  it('enforces length bounds', () => {
    expect(isValidPassword('short')).toBe(false);       // < 8
    expect(isValidPassword('longenough')).toBe(true);
    expect(isValidPassword('x'.repeat(201))).toBe(false); // > 200
    expect(isValidPassword(12345678)).toBe(false);        // non-string
  });
});
