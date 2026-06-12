// Admin portal API (all routes gated to ADMIN_EMAILS):
//   GET  /admin/users                       -> list all users
//   POST /admin/credits  { userId, monthlyDelta?, topupDelta?, reason }
//   POST /admin/tier     { userId, tier }   -> override tier + reset monthly allowance
import {
  listAllUsers,
  adminAdjustCredits,
  adminSetTier,
  totalCredits,
} from '../lib/dynamo.mjs';
import { PLANS } from '../../../shared/catalog.mjs';
import { isAdmin } from '../lib/admin.mjs';
import { ok, badRequest, unauthorized, json, parseBody, claims } from '../lib/http.mjs';

export const handler = async (event) => {
  const c = claims(event);
  if (!c?.userId) return unauthorized();
  if (!isAdmin(c.email)) return json(403, { error: 'admin_only' });

  const path = event.rawPath || '';
  const method = event.requestContext?.http?.method || 'GET';

  if (method === 'GET' && path.endsWith('/users')) {
    const users = (await listAllUsers()).map(shape);
    return ok({ users });
  }

  const body = parseBody(event);
  if (path.endsWith('/credits')) {
    if (!body.userId) return badRequest('userId required');
    const res = await adminAdjustCredits({
      userId: body.userId,
      monthlyDelta: Number(body.monthlyDelta) || 0,
      topupDelta: Number(body.topupDelta) || 0,
      adminEmail: c.email,
      reason: body.reason,
    });
    return ok(res);
  }
  if (path.endsWith('/tier')) {
    if (!body.userId || !PLANS[body.tier]) return badRequest('userId + valid tier required');
    const user = await adminSetTier({
      userId: body.userId,
      tier: body.tier,
      monthlyCredits: PLANS[body.tier].monthlyCredits,
      adminEmail: c.email,
    });
    return ok({ user: shape(user) });
  }

  return badRequest('Unknown admin route');
};

function shape(u) {
  return {
    userId: u.userId,
    email: u.email,
    name: u.name,
    tier: u.tier,
    credits: totalCredits(u),
    monthlyCredits: u.credits || 0,
    topupCredits: u.topupCredits || 0,
    hasSubscription: !!u.stripeCustomerId,
    createdAt: u.createdAt,
  };
}
