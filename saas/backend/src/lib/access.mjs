// Account access gate — the single evaluator for "may this account use the
// product right now?", separate from `accountBlocked` (admin suspension) and
// from credits (which gate individual runs, not the account).
//
// Two windows, both 7 days (shared/catalog.mjs ACCESS):
//   • Free  — a Free account is a TRIAL. It opens at sign-up and closes
//             `freeTrialDays` later; after that only a subscription reopens it.
//   • Paid  — a failed renewal starts a `pastDueGraceDays` grace window from the
//             first failed charge. Stripe's dunning retries run inside it; if
//             none succeed, the account locks until payment lands.
//
// A lock DELETES NOTHING. Projects, runs, rankings, integrations and history all
// stay on the record untouched — the moment an invoice is paid the same data is
// there. Everything here is derived from timestamps on the user item, so it is
// always current: there is no "locked" flag to go stale, and no cron has to run
// for a window to close.
import { ACCESS, PLANS } from '../../../shared/catalog.mjs';
import { isStaff } from './admin.mjs';

const DAY = 86_400_000;
const ms = (iso) => { const t = Date.parse(iso || ''); return Number.isFinite(t) ? t : null; };
const plus = (iso, days) => { const t = ms(iso); return t == null ? null : new Date(t + days * DAY).toISOString(); };

/** When does this account's free trial run out? Explicit field wins (admins can
 *  extend it, and a cancelled subscription sets it); otherwise it's the sign-up
 *  date + the trial length. Accounts created before this feature shipped have
 *  neither field set in a useful way — `createdAt` has always been written, so
 *  they date from sign-up like everyone else. */
export function freeTrialEndsAt(user) {
  return user?.freeAccessEndsAt || plus(user?.createdAt, ACCESS.freeTrialDays);
}

/** When does a past-due subscriber's grace window run out? Null if not past due. */
export function graceEndsAt(user) {
  if (!user?.pastDue) return null;
  // `pastDueSince` is stamped when the first charge fails. A record flagged by
  // an older deploy has no stamp — fall back to `updatedAt` (the flagging write),
  // which is the closest thing to "when this went wrong" that we kept.
  return plus(user.pastDueSince || user.updatedAt, ACCESS.pastDueGraceDays);
}

/**
 * Full access state for a user record.
 *   { locked, reason, endsAt, daysLeft, warn }
 * `reason` is 'free_trial_expired' | 'payment_overdue' when locked, and
 * 'free_trial' | 'past_due_grace' while a window is still open.
 */
export function accessState(user) {
  const open = { locked: false, reason: null, endsAt: null, daysLeft: null, warn: false };
  if (!user) return open;
  // Staff run the platform; their accounts are never on a billing clock.
  if (isStaff(user)) return open;

  const now = Date.now();
  const isFree = (user.tier || 'free') === 'free' || !PLANS[user.tier];

  const endsAt = isFree ? freeTrialEndsAt(user) : graceEndsAt(user);
  if (!endsAt) return open;                       // paid + current → no clock

  const left = ms(endsAt) - now;
  const reason = isFree
    ? (left <= 0 ? 'free_trial_expired' : 'free_trial')
    : (left <= 0 ? 'payment_overdue' : 'past_due_grace');
  return {
    locked: left <= 0,
    reason,
    endsAt,
    daysLeft: Math.max(0, Math.ceil(left / DAY)),
    warn: left > 0 && left <= ACCESS.warnDays * DAY,
  };
}

/** Convenience predicate for handler guards. */
export const accessLocked = (user) => accessState(user).locked;

/** The 403 body every locked endpoint returns. The frontend keys the paywall
 *  screen off `error: 'access_locked'` and words it from `reason`. */
export function accessLockedResponse(user) {
  const s = accessState(user);
  return {
    error: 'access_locked',
    reason: s.reason,
    endsAt: s.endsAt,
    // Said once here so every surface that renders this payload says the same
    // thing: nothing has been removed.
    message: s.reason === 'payment_overdue'
      ? 'Your subscription payment didn’t go through, so this account is on hold. Your data is safe and untouched — update your card to unlock it.'
      : 'Your 7-day free trial has ended. Your data is safe and untouched — choose a plan to unlock it.',
  };
}
