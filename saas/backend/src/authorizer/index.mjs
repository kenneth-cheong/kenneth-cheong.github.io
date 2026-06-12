// API Gateway HTTP API Lambda authorizer (payload v2, simple response).
// Verifies our access JWT and passes claims downstream as `authorizer.lambda`.
import { verify } from '../lib/jwt.mjs';

export const handler = async (event) => {
  const header = event.identitySource?.[0] || event.headers?.authorization || '';
  const token = header.replace(/^Bearer\s+/i, '');

  try {
    const c = verify(token);
    if (c.typ === 'refresh') throw new Error('refresh token not accepted here');
    return {
      isAuthorized: true,
      context: { userId: c.sub, email: c.email, tier: c.tier },
    };
  } catch {
    return { isAuthorized: false };
  }
};
