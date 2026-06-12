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
  return jwt.sign({ sub: user.userId, typ: 'refresh' }, SECRET, {
    expiresIn: REFRESH_TTL,
    issuer: 'digimetrics-saas',
  });
}

export function verify(token) {
  return jwt.verify(token, SECRET, { issuer: 'digimetrics-saas' });
}
