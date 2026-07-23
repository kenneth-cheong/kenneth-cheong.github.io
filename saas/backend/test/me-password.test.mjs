import { describe, it, expect, vi, beforeEach } from 'vitest';
import { hashPassword, verifyPassword } from '../src/lib/password.mjs';

// POST /me/password is the signed-in way to set or change a password. It matters
// most for accounts created through Google, which have no password at all — and
// therefore can't use a claimed username, since username sign-in goes through
// the password form. The asymmetry it encodes: proving the CURRENT password is
// required only when there is one.

let user = null;
const writes = [];
vi.mock('../src/lib/dynamo.mjs', () => ({
  getUser: async () => user,
  putUser: async (u) => { writes.push(u); user = u; },
  listLedger: async () => [],
  totalCredits: (u) => (u.credits || 0) + (u.topupCredits || 0),
  getSettings: async () => ({}),
  reserveUsername: async () => true,
  releaseUsername: async () => {},
}));
vi.mock('../src/lib/access.mjs', () => ({ accessState: () => ({ locked: false }) }));

const { handler } = await import('../src/me/index.mjs');

const call = (body, path = '/me/password') => handler({
  rawPath: path,
  requestContext: { http: { method: 'POST' }, authorizer: { lambda: { userId: 'u1', email: 'a@b.co' } } },
  body: JSON.stringify(body),
});
const bodyOf = (res) => JSON.parse(res.body);

beforeEach(() => {
  writes.length = 0;
  user = { userId: 'u1', email: 'a@b.co', tier: 'free', credits: 30, status: 'active' };
});

describe('setting a first password (Google-only account)', () => {
  it('accepts one with no current password to prove', async () => {
    // The bearer token IS the proof here — demanding a current password would
    // lock a Google user out of the feature entirely.
    const res = await call({ password: 'hunter2hunter' });
    expect(res.statusCode).toBe(200);
    expect(bodyOf(res).hasPassword).toBe(true);
    expect(verifyPassword('hunter2hunter', writes[0].passwordHash)).toBe(true);
  });

  it('never stores the password in the clear', async () => {
    await call({ password: 'hunter2hunter' });
    expect(JSON.stringify(writes[0])).not.toContain('hunter2hunter');
  });

  it('rejects anything under 8 characters', async () => {
    const res = await call({ password: 'short' });
    expect(res.statusCode).toBe(400);
    expect(writes).toHaveLength(0);
  });

  it('rejects a missing password outright', async () => {
    expect((await call({})).statusCode).toBe(400);
    expect(writes).toHaveLength(0);
  });
});

describe('changing an existing password', () => {
  beforeEach(() => { user.passwordHash = hashPassword('oldpassword'); });

  it('requires the current one', async () => {
    const res = await call({ password: 'newpassword' });
    expect(res.statusCode).toBe(400);
    expect(writes).toHaveLength(0);
  });

  it('rejects a wrong current one', async () => {
    // Otherwise a stolen session could silently take the account over.
    const res = await call({ password: 'newpassword', currentPassword: 'guessing' });
    expect(res.statusCode).toBe(400);
    expect(writes).toHaveLength(0);
  });

  it('replaces the hash when the current one checks out', async () => {
    const res = await call({ password: 'newpassword', currentPassword: 'oldpassword' });
    expect(res.statusCode).toBe(200);
    expect(verifyPassword('newpassword', writes[0].passwordHash)).toBe(true);
    expect(verifyPassword('oldpassword', writes[0].passwordHash)).toBe(false);
  });

  it('refuses a no-op change', async () => {
    const res = await call({ password: 'oldpassword', currentPassword: 'oldpassword' });
    expect(res.statusCode).toBe(400);
    expect(writes).toHaveLength(0);
  });

  it('kills any outstanding emailed reset link', async () => {
    // A link minted earlier — possibly by someone else fishing — must not stay
    // redeemable once the holder has proved themselves and set a password.
    user.pwReset = { jti: 'abc', exp: Date.now() + 3600_000 };
    await call({ password: 'newpassword', currentPassword: 'oldpassword' });
    expect(writes[0].pwReset).toBeNull();
  });
});

describe('GET /me', () => {
  const get = () => handler({
    rawPath: '/me',
    requestContext: { http: { method: 'GET' }, authorizer: { lambda: { userId: 'u1', email: 'a@b.co' } } },
  });

  it('reports whether a password is set, without leaking the hash', async () => {
    expect(bodyOf(await get()).user.hasPassword).toBe(false);
    user.passwordHash = hashPassword('oldpassword');
    const res = bodyOf(await get());
    expect(res.user.hasPassword).toBe(true);
    expect(JSON.stringify(res)).not.toContain(user.passwordHash);
  });
});
