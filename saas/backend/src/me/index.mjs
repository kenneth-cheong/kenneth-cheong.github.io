// Authenticated profile + usage endpoints:
//   GET  /me           -> current user (tier, live credit balance, plan limits)
//   GET  /me/usage     -> recent credit-ledger rows for the usage dashboard
//   POST /me/username  -> claim / change the opt-in sign-in handle
//
// /me/username lives here rather than next to /me/profile on AppFn because
// AppFn's Lambda resource policy is at the hard 20KB ceiling — SAM adds a
// statement per HttpApi route, and one more tipped it over (the deploy failed
// with "final policy size (20486) is bigger than the limit (20480)"). MeFn
// carries two routes, so it has room.
import {
  getUser, listLedger, totalCredits, getSettings,
  putUser, reserveUsername, releaseUsername,
} from '../lib/dynamo.mjs';
import { PLANS } from '../../../shared/catalog.mjs';
import { ok, badRequest, unauthorized, forbidden, serverError, claims, parseBody, isUsername, clampStr } from '../lib/http.mjs';
import { isStaff, isAdmin, accountBlocked } from '../lib/admin.mjs';

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
    const method = event.requestContext?.http?.method || 'GET';
    if (path.endsWith('/usage')) {
      const rows = await listLedger(user.userId, 200);
      return ok({ usage: rows });
    }

    // ── Claim / change a username (opt-in sign-in handle) ────────────────────
    // Deliberately NOT gated on usernameAuthEnabled: an admin needs users to be
    // able to claim handles BEFORE switching username sign-in on, or the toggle
    // goes live with nobody holding one. The setting gates the LOGIN path only.
    //
    // Uniqueness is the reservation item, not the GSI (a GSI can't enforce it).
    // Order matters: reserve the new handle, then write the user, then release
    // the old one. If a step fails midway we leak a reservation we still own —
    // recoverable, and reserveUsername is idempotent for the owner — whereas
    // releasing first could hand our old handle to someone else and then fail.
    // Must precede the /me fall-through below, which answers any other path.
    if (method === 'POST' && path.endsWith('/me/username')) {
      const body = parseBody(event) || {};
      const desired = clampStr(body.username, 40).trim();
      if (!isUsername(desired)) {
        return badRequest('Usernames are 3–30 characters — letters, numbers, and . _ - — and must start and end with a letter or number.');
      }
      const current = user.username || null;
      if (current && current.toLowerCase() === desired.toLowerCase()) {
        // Same handle; only the display case changed. The reservation key is the
        // lowercase form, so there's nothing to re-reserve.
        if (current !== desired) await putUser({ ...user, username: desired, updatedAt: new Date().toISOString() });
        return ok({ username: desired });
      }
      if (!(await reserveUsername(desired, user.userId))) {
        return badRequest('That username is already taken.');
      }
      await putUser({ ...user, username: desired, updatedAt: new Date().toISOString() });
      if (current) await releaseUsername(current, user.userId);
      return ok({ username: desired });
    }

    const plan = PLANS[user.tier];
    // Proactive-assistant config, admin-tuned (Admin → Assistant). Ship the master
    // switch + global caps, and only the ENABLED triggers so clients don't carry or
    // evaluate ones an admin has turned off.
    const settings = await getSettings();
    const pa = settings.proactive || {};
    const proactive = {
      enabled: pa.enabled !== false,
      maxPerSession: pa.maxPerSession,
      defaultCooldownHours: pa.defaultCooldownHours,
      triggers: (pa.triggers || []).filter((t) => t.enabled),
    };
    return ok({
      user: {
        proactive,
        userId: user.userId,
        email: user.email,
        // null until the user claims one — usernames are opt-in.
        username: user.username || null,
        name: user.name,
        picture: user.picture,
        tier: user.tier,
        credits: totalCredits(user),
        monthlyCredits: user.credits || 0,
        topupCredits: user.topupCredits || 0,
        periodEnd: user.periodEnd,
        // "Has a plan to manage", NOT "has ever paid us". A Free user who bought a
        // one-off top-up owns a Stripe customer too, and on the customer id alone
        // Pricing.jsx would route them to the in-place plan switch — which has no
        // subscription to switch, so they could never subscribe at all.
        hasSubscription: !!user.stripeCustomerId && user.tier !== 'free',
        pastDue: !!user.pastDue, // surfaced as an "update card" banner in the UI
        isAdmin: isStaff(user),
        // True permanent admin (ADMIN_EMAILS allowlist), distinct from `isAdmin`
        // above (which is really "is staff"). Gates who can grant staff access.
        isSuperAdmin: isAdmin(user.email),
        createdAt: user.createdAt,            // drives "is this a brand-new account" in the UI
        onboarding: user.onboarding || null,  // welcome flow / chosen goal / dismissed checklist
        profile: user.profile || {},          // progressive-profiling answers (Profile page + Dashboard card)
        profileBonusGranted: !!user.profileBonusGrantedAt, // one-time completion reward already paid?
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
