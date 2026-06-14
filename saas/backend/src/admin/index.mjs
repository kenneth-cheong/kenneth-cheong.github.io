// Admin portal API (all routes gated to staff — ADMIN_EMAILS allowlist OR a
// per-user role: 'staff' flag):
//   GET  /admin/users                        -> list all users + invited accounts
//   POST /admin/users  { email, name?, role?, tier?, credits?, sendInvite? }
//                                            -> provision a client/staff account
//   POST /admin/credits { userId, monthlyDelta?, topupDelta?, reason }
//   POST /admin/tier    { userId, tier }     -> override tier + reset allowance
import {
  getUser,
  listAllUsers,
  createProvision,
  adminAdjustCredits,
  adminSetTier,
  totalCredits,
} from '../lib/dynamo.mjs';
import { PLANS } from '../../../shared/catalog.mjs';
import { isAdmin, isStaff } from '../lib/admin.mjs';
import { sendEmail } from '../lib/email.mjs';
import { ok, badRequest, unauthorized, json, parseBody, claims, isEmail } from '../lib/http.mjs';

const APP_ORIGIN = process.env.APP_ORIGIN || '';

export const handler = async (event) => {
  const c = claims(event);
  if (!c?.userId) return unauthorized();
  const me = await getUser(c.userId);
  if (!isStaff(me)) return json(403, { error: 'admin_only' });

  const path = event.rawPath || '';
  const method = event.requestContext?.http?.method || 'GET';

  if (method === 'GET' && path.endsWith('/users')) {
    const users = (await listAllUsers()).map(shape);
    return ok({ users });
  }

  const body = parseBody(event);

  if (method === 'POST' && path.endsWith('/users')) {
    const email = String(body.email || '').trim();
    if (!isEmail(email)) return badRequest('A valid email is required.');
    const role = body.role === 'staff' ? 'staff' : 'client';
    const tier = PLANS[body.tier] ? body.tier : 'free';
    const credits = Number.isFinite(Number(body.credits)) ? Math.max(0, Number(body.credits)) : PLANS[tier].monthlyCredits;
    const provision = await createProvision({ email, name: (body.name || '').trim(), role, tier, credits, invitedBy: c.email });
    if (body.sendInvite) {
      await sendEmail({
        to: email,
        subject: 'You’ve been invited to Digimetrics',
        text: `You've been added to Digimetrics${role === 'staff' ? ' as a staff member' : ''}.\n\n`
          + `Sign in with Google using this email (${email}) to activate your account:\n${APP_ORIGIN || 'the Digimetrics app'}\n`,
      });
    }
    return ok({ user: shape(provision) });
  }

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
  const invited = !!u.provision || String(u.userId || '').startsWith('pending:');
  return {
    userId: u.userId,
    email: u.email,
    name: u.name,
    tier: u.tier,
    role: u.role || (isAdmin(u.email) ? 'staff' : 'client'),
    status: invited ? 'invited' : 'active',
    credits: invited ? (u.credits || 0) : totalCredits(u),
    monthlyCredits: u.credits || 0,
    topupCredits: u.topupCredits || 0,
    hasSubscription: !!u.stripeCustomerId,
    createdAt: u.createdAt,
  };
}
