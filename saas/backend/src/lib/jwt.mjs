// Issue + verify our own short-lived access tokens and longer refresh tokens.
import jwt from 'jsonwebtoken';

const SECRET = process.env.JWT_SECRET;
const ACCESS_TTL = '30m';
const REFRESH_TTL = '30d';

export function signAccess(user) {
  return jwt.sign(
    { sub: user.userId, email: user.email, tier: user.tier },
    SECRET,
    { expiresIn: ACCESS_TTL, issuer: 'digimetrics-saas' }
  );
}

export function signRefresh(user) {
  // `tv` (token version) lets us revoke all refresh tokens at once: bump the
  // user's tokenVersion and any older refresh token stops validating.
  return jwt.sign({ sub: user.userId, typ: 'refresh', tv: user.tokenVersion || 0 }, SECRET, {
    expiresIn: REFRESH_TTL,
    issuer: 'digimetrics-saas',
  });
}

export function verify(token) {
  return jwt.verify(token, SECRET, { issuer: 'digimetrics-saas' });
}

// Short-lived signed state for the Google OAuth round-trip (ties the public
// callback back to the user who started it).
export function signOAuthState(userId, provider) {
  return jwt.sign({ sub: userId, provider, typ: 'oauth' }, SECRET, { expiresIn: '15m', issuer: 'digimetrics-saas' });
}
export function verifyOAuthState(token) {
  const t = jwt.verify(token, SECRET, { issuer: 'digimetrics-saas' });
  if (t.typ !== 'oauth') throw new Error('bad oauth state');
  return t;
}
