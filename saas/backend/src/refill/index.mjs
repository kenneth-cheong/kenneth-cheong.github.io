// Scheduled job (EventBridge, daily): refill free-tier users' monthly credit
// allowance. Paid users refill via the Stripe `invoice.paid` webhook (the billing
// cycle anchor); free users never generate an invoice, so without this their
// monthly allowance would only ever be granted once at signup.
//
// Idempotent per user/period: refillFreeTier conditionally writes a 30-day-ahead
// `freeRefillAt`, so a user is refilled at most once per period even if the daily
// job overlaps or reruns.
import { scanAllUsers, refillFreeTier } from '../lib/dynamo.mjs';
import { PLANS } from '../../../shared/catalog.mjs';

const PERIOD_MS = 30 * 86400_000;

export const handler = async () => {
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const nextAt = new Date(now + PERIOD_MS).toISOString();
  const allowance = PLANS.free.monthlyCredits;

  const users = await scanAllUsers();
  let refilled = 0;
  for (const u of users) {
    if ((u.tier || 'free') !== 'free') continue;          // paid users refill via invoice.paid
    if (u.freeRefillAt && u.freeRefillAt > nowIso) continue; // not due yet
    try {
      const res = await refillFreeTier({ userId: u.userId, monthlyCredits: allowance, nextAt, seenAt: u.freeRefillAt });
      if (res) refilled++;
    } catch (e) { console.error('free_refill_failed', u.userId, e.message); }
  }
  console.log(JSON.stringify({ metric: 'free_refill', total: users.length, refilled }));
  return { refilled };
};
