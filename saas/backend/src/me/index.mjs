// Authenticated profile + usage endpoints:
//   GET /me          -> current user (tier, live credit balance, plan limits)
//   GET /me/usage    -> recent credit-ledger rows for the usage dashboard
import { getUser, listLedger, totalCredits } from '../lib/dynamo.mjs';
import { PLANS } from '../../../shared/catalog.mjs';
import { ok, unauthorized, forbidden, serverError, claims } from '../lib/http.mjs';
import { isStaff, accountBlocked } from '../lib/admin.mjs';

export const handler = async (event) => {
  try {
    const c = claims(event);
    if (!c?.userId) return unauthorized();
    const user = await getUser(c.userId);
    if (!user) return unauthorized('User not found');
    // Blocked accounts get bounced — the frontend clears the session and the
    // sign-in screen shows why (it reads the account_suspended payload).
    if (accountBlocked(user)) return forbidden({ error: 'account_suspended', status: user.status });

    const path = event.rawPath || '';
    if (path.endsWith('/usage')) {
      const rows = await listLedger(user.userId, 200);
      return ok({ usage: rows });
    }

    const plan = PLANS[user.tier];
    return ok({
      user: {
        userId: user.userId,
        email: user.email,
        name: user.name,
        picture: user.picture,
        tier: user.tier,
        credits: totalCredits(user),
        monthlyCredits: user.credits || 0,
        topupCredits: user.topupCredits || 0,
        periodEnd: user.periodEnd,
        hasSubscription: !!user.stripeCustomerId,
        pastDue: !!user.pastDue, // surfaced as an "update card" banner in the UI
        isAdmin: isStaff(user),
        createdAt: user.createdAt,            // drives "is this a brand-new account" in the UI
        onboarding: user.onboarding || null,  // welcome flow / chosen goal / dismissed checklist
        emailOptOut: !!user.notifyEmailOptOut, // product-update email preference (Account toggle)
        sessions: (user.sessions || []).map((s) => ({ sid: s.sid, device: s.device, ip: s.ip, lastSeenAt: s.lastSeenAt, createdAt: s.createdAt })),
      },
      plan: { ...plan },
    });
  } catch (err) {
    console.error('me_error', err);
    return serverError('Something went wrong. Please try again.');
  }
};
