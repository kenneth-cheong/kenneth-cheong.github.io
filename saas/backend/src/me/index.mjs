// Authenticated profile + usage endpoints:
//   GET /me          -> current user (tier, live credit balance, plan limits)
//   GET /me/usage    -> recent credit-ledger rows for the usage dashboard
import { getUser, listLedger, totalCredits } from '../lib/dynamo.mjs';
import { PLANS } from '../../../shared/catalog.mjs';
import { ok, unauthorized, claims } from '../lib/http.mjs';
import { isStaff } from '../lib/admin.mjs';

export const handler = async (event) => {
  const c = claims(event);
  if (!c?.userId) return unauthorized();
  const user = await getUser(c.userId);
  if (!user) return unauthorized('User not found');

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
      isAdmin: isStaff(user),
    },
    plan: { ...plan },
  });
};
