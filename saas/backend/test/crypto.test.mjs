import { describe, it, expect } from 'vitest';
import { encrypt, decrypt } from '../src/lib/crypto.mjs';

describe('crypto', () => {
  it('round-trips a token', () => { const t = '1//refresh-abc'; expect(decrypt(encrypt(t))).toBe(t); });
  it('passes through plaintext / legacy values', () => { expect(decrypt('plain')).toBe('plain'); });
  it('returns empty string on tampered ciphertext', () => { const e = encrypt('secret'); expect(decrypt(e.slice(0, -3) + 'zzz')).toBe(''); });
  it('leaves empty values untouched', () => { expect(encrypt('')).toBe(''); expect(decrypt('')).toBe(''); });
});
