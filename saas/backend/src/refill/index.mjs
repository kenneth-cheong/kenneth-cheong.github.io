// Scheduled job (EventBridge, daily), two passes over the user table:
//
//   1. Refill free-tier users' monthly credit allowance. Paid users refill via
//      the Stripe `invoice.paid` webhook (the billing cycle anchor); free users
//      never generate an invoice, so without this their monthly allowance would
//      only ever be granted once at signup.
//   2. Warn accounts approaching an access lock — a trial about to end, or a
//      failed payment about to run out its grace window — and tell them once
//      more on the day it closes. Both windows are silent by nature (nothing
//      happens until suddenly everything stops), so this is the only warning a
//      user gets before being locked out.
//
// Idempotent per user/period: refillFreeTier conditionally writes a 30-day-ahead
// `freeRefillAt`, so a user is refilled at most once per period even if the daily
// job overlaps or reruns. The notices carry their own per-stage stamp.
import { scanAllUsers, refillFreeTier, addNotification, setAccessNotice } from '../lib/dynamo.mjs';
import { PLANS, ACCESS } from '../../../shared/catalog.mjs';
import { accessLocked, accessState } from '../lib/access.mjs';
import { sendNotice } from '../lib/email.mjs';

const PERIOD_MS = 30 * 86400_000;
const APP_ORIGIN = (process.env.APP_ORIGIN || '').replace(/\/$/, '');

// What to say at each stage. `stage` doubles as the idempotency stamp, so each
// message is sent at most once per window — and a window that resets (payment
// lands, trial extended) clears the stamp and can warn again later.
function noticeFor(state) {
  const days = state.daysLeft;
  const plural = days === 1 ? 'day' : 'days';
  switch (state.reason) {
    case 'free_trial':
      return { stage: `free_trial:${days}`, title: `Your free trial ends in ${days} ${plural}`,
        body: `Choose a plan to keep your projects, rankings and reports available. Nothing is deleted when a trial ends — your data waits for you.` };
    case 'free_trial_expired':
      return { stage: 'free_trial:0', title: 'Your free trial has ended',
        body: 'Your account is on hold. Everything you created is still here, untouched — pick a plan to unlock it.' };
    case 'past_due_grace':
      return { stage: `past_due:${days}`, title: `Payment failed — ${days} ${plural} left`,
        body: `We couldn't charge your card. Update it to avoid losing access. Your data stays safe either way.` };
    case 'payment_overdue':
      return { stage: 'past_due:0', title: 'Your account is on hold',
        body: 'We still haven’t been able to take payment. Your data is safe and untouched — update your card to unlock the account.' };
    default:
      return null;
  }
}

export const handler = async () => {
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const nextAt = new Date(now + PERIOD_MS).toISOString();
  const allowance = PLANS.free.monthlyCredits;

  const users = await scanAllUsers();
  let refilled = 0, warned = 0;
  for (const u of users) {
    try { warned += await warnIfClosing(u); }
    catch (e) { console.error('access_notice_failed', u.userId, e.message); }

    if ((u.tier || 'free') !== 'free') continue;          // paid users refill via invoice.paid
    if (u.freeRefillAt && u.freeRefillAt > nowIso) continue; // not due yet
    // Free is a 7-day trial, so a monthly refill now only reaches accounts whose
    // window is still open (extended trials, staff). Refilling a locked account
    // would write a "monthly_reset_free" ledger row promising credits it can't
    // spend — and the balance is preserved anyway, so there is nothing to restore.
    if (accessLocked(u)) continue;
    try {
      const res = await refillFreeTier({ userId: u.userId, monthlyCredits: allowance, nextAt, seenAt: u.freeRefillAt });
      if (res) refilled++;
    } catch (e) { console.error('free_refill_failed', u.userId, e.message); }
  }
  console.log(JSON.stringify({ metric: 'free_refill', total: users.length, refilled, warned }));
  return { refilled, warned };
};

/** One in-app + email notice per stage of a closing access window. Returns 1 if
 *  it sent, 0 otherwise. */
async function warnIfClosing(user) {
  const state = accessState(user);
  // Nothing on the clock (paid and current, or staff), or still early enough in
  // the window that a warning would be noise.
  if (!state.reason || (!state.warn && !state.locked)) {
    // Window reset (they paid, or an admin extended the trial) → forget the
    // stamps so a future window can warn from scratch.
    if (user.accessNoticeStage) await setAccessNotice(user.userId, null);
    return 0;
  }
  // Three messages per window, not one a day: first warning, last-day warning,
  // and the lock itself. A daily countdown for a week reads as nagging and gets
  // filtered, which costs us the one email that actually matters.
  if (!state.locked && state.daysLeft !== ACCESS.warnDays && state.daysLeft !== 1) return 0;

  const notice = noticeFor(state);
  if (!notice || user.accessNoticeStage === notice.stage) return 0;

  await addNotification({
    userId: user.userId,
    title: notice.title,
    body: notice.body,
    link: '/pricing',
    kind: 'billing',
  });
  // Transactional, and deliberately not gated on the product-update opt-out:
  // losing access to your account is not marketing.
  await sendNotice({
    to: user.email,
    subject: notice.title,
    text: `${notice.body}\n\n${APP_ORIGIN}/pricing`,
  }).catch((e) => console.error('access_notice_email', user.userId, e.message));

  await setAccessNotice(user.userId, notice.stage);
  return 1;
}

// Exported for unit tests.
export const __test = { noticeFor, warnIfClosing, ACCESS };
