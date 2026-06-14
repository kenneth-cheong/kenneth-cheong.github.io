import { describe, it, expect, vi } from 'vitest';
import jwt from 'jsonwebtoken';

// jwt.mjs reads JWT_SECRET at module load — set it before importing.
vi.hoisted(() => { process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod'; });
const { signAccess, signRefresh, verify, signOAuthState, verifyOAuthState } = await import('../src/lib/jwt.mjs');

const USER = { userId: 'google:123', email: 'a@b.co', tier: 'pro' };

describe('jwt', () => {
  it('signs + verifies an access token with our claims', () => {
    const t = verify(signAccess(USER));
    expect(t.sub).toBe('google:123');
    expect(t.email).toBe('a@b.co');
    expect(t.tier).toBe('pro');
    expect(t.iss).toBe('digimetrics-saas');
  });

  it('signs + verifies a refresh token (typ=refresh)', () => {
    const t = verify(signRefresh(USER));
    expect(t.sub).toBe('google:123');
    expect(t.typ).toBe('refresh');
  });

  it('rejects a tampered token', () => {
    const t = signAccess(USER);
    expect(() => verify(t.slice(0, -3) + 'zzz')).toThrow();
  });

  it('rejects a token signed with a different secret', () => {
    const forged = jwt.sign({ sub: 'x' }, 'attacker-secret', { issuer: 'digimetrics-saas' });
    expect(() => verify(forged)).toThrow();
  });

  it('rejects a token with the wrong issuer', () => {
    const wrong = jwt.sign({ sub: 'x' }, process.env.JWT_SECRET, { issuer: 'someone-else' });
    expect(() => verify(wrong)).toThrow();
  });

  it('rejects an expired token', () => {
    const expired = jwt.sign({ sub: 'x' }, process.env.JWT_SECRET, { issuer: 'digimetrics-saas', expiresIn: -10 });
    expect(() => verify(expired)).toThrow();
  });

  it('OAuth state: verifies typ=oauth, rejects a non-oauth token of the same secret', () => {
    const ok = verifyOAuthState(signOAuthState('google:123', 'gsc'));
    expect(ok.sub).toBe('google:123');
    expect(ok.provider).toBe('gsc');
    // An access token is validly signed but must NOT pass the oauth-state gate
    // (prevents token-type confusion).
    expect(() => verifyOAuthState(signAccess(USER))).toThrow();
  });
});
