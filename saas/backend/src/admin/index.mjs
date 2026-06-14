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
  requestAccess,
  listAccessGrants,
  activeAccess,
  listRuns,
  listConversations,
  getConversation,
  toolUsageCounts,
  addNotification,
} from '../lib/dynamo.mjs';
import { PLANS } from '../../../shared/catalog.mjs';
import { isAdmin, isStaff } from '../lib/admin.mjs';
import { sendEmail } from '../lib/email.mjs';
import { ok, badRequest, unauthorized, serverError, json, parseBody, claims, isEmail } from '../lib/http.mjs';

const APP_ORIGIN = process.env.APP_ORIGIN || '';

export const handler = async (event) => {
  try {
  const c = claims(event);
  if (!c?.userId) return unauthorized();
  const me = await getUser(c.userId);
  if (!isStaff(me)) return json(403, { error: 'admin_only' });

  const path = event.rawPath || '';
  const method = event.requestContext?.http?.method || 'GET';
  const q = event.queryStringParameters || {};

  if (method === 'GET' && path.endsWith('/users')) {
    const users = (await listAllUsers()).map(shape);
    return ok({ users });
  }

  // Per-tool usage COUNTS for a user — operational/billing metadata, not
  // content, so it's available without a consent grant (like credit totals).
  if (method === 'GET' && path.endsWith('/admin/usage')) {
    if (!q.userId) return badRequest('userId required');
    return ok(await toolUsageCounts(q.userId));
  }

  // ── Consent-gated access to a user's activity ──────────────────────────────
  // GET access status for a user (what grants exist).
  if (method === 'GET' && path.endsWith('/admin/access')) {
    if (!q.userId) return badRequest('userId required');
    return ok({ grants: await listAccessGrants(q.userId) });
  }
  // Read a user's runs / conversations — ONLY if they have an active grant.
  if (method === 'GET' && path.endsWith('/admin/activity')) {
    if (!q.userId) return badRequest('userId required');
    const target = await getUser(q.userId);
    if (!target) return badRequest('User not found');
    if (!activeAccess(target)) return json(403, { error: 'no_consent', message: 'This user has not granted access. Request it and wait for them to allow it.' });
    // Audit every cross-user view.
    console.log(JSON.stringify({ audit: 'admin_view', admin: c.email, target: q.userId, kind: q.kind || 'runs', id: q.id || null, at: new Date().toISOString() }));
    if (q.kind === 'conversations') return ok({ conversations: await listConversations(q.userId, 50) });
    if (q.kind === 'conversation') { const conv = await getConversation(q.userId, q.id); return conv ? ok({ conversation: conv }) : badRequest('Not found'); }
    return ok({ runs: await listRuns(q.userId, 100) });
  }

  const body = parseBody(event);

  // Staff requests access to a user's activity (creates a pending grant + notifies them).
  if (method === 'POST' && path.endsWith('/admin/access')) {
    if (!body.userId) return badRequest('userId required');
    const target = await getUser(body.userId);
    if (!target) return badRequest('User not found');
    const grant = await requestAccess({ userId: body.userId, requestedBy: c.email, reason: body.reason });
    await addNotification({
      userId: body.userId,
      title: 'Support is requesting data access',
      body: `A staff member asked to view your tool usage & conversations${body.reason ? ` ("${String(body.reason).slice(0, 80)}")` : ''}. Review under Account → Data access.`,
    });
    return ok({ grant });
  }

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
  } catch (err) {
    console.error('admin_error', err);
    return serverError('Something went wrong. Please try again.');
  }
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
