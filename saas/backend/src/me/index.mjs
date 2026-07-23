// Authenticated profile + usage endpoints:
//   GET  /me           -> current user (tier, live credit balance, plan limits)
//   GET  /me/usage     -> recent credit-ledger rows for the usage dashboard
//   POST /me/username  -> claim / change the opt-in sign-in handle
//   POST /me/password  -> set / change the account password (authed)
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
import { hashPassword, verifyPassword, isValidPassword, MIN_PASSWORD_LEN } from '../lib/password.mjs';
import { accessState } from '../lib/access.mjs';

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

    // ── Set / change the account password ───────────────────────────────────
    // The signed-in counterpart to /auth/reset. Without this the only way to get
    // a password is the login screen's "forgot" flow — which a Google-only user
    // has to abuse to claim a password they never had, and which a user who
    // simply wants to CHANGE a known password has to go through email for.
    //
    // Not gated on the passwordAuthEnabled setting, for the same reason the
    // username claim isn't: handles and passwords must both be settable BEFORE
    // an admin flips sign-in on, or the switch goes live with nobody able to use
    // it. The setting gates the LOGIN path only.
    //
    // `currentPassword` is required only when one is already set. For an account
    // that has none (Google sign-in), the bearer token IS the proof of identity —
    // demanding a current password there would lock them out of the feature
    // entirely. Changing an existing password always re-proves it, so a stolen
    // session can't silently take the account over by swapping the password.
    if (method === 'POST' && path.endsWith('/me/password')) {
      const body = parseBody(event) || {};
      const next = String(body.password || '');
      if (!isValidPassword(next)) {
        return badRequest(`Password must be at least ${MIN_PASSWORD_LEN} characters.`);
      }
      if (user.passwordHash) {
        const current = String(body.currentPassword || '');
        if (!current) return badRequest('Enter your current password.');
        if (!verifyPassword(current, user.passwordHash)) {
          return badRequest('That current password is not right.');
        }
        if (current === next) return badRequest('That is already your password.');
      }
      await putUser({
        ...user,
        passwordHash: hashPassword(next),
        // Any outstanding emailed reset link dies here: the account holder has
        // just proved themselves and set a password, so a link minted earlier
        // (possibly by someone else fishing) must not still be redeemable.
        pwReset: null,
        updatedAt: new Date().toISOString(),
      });
      console.log(JSON.stringify({ audit: 'me_password_set', userId: user.userId, replaced: !!user.passwordHash, at: new Date().toISOString() }));
      return ok({ hasPassword: true });
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
        // Whether a password is set at all, so Account can offer "Set a password"
        // to a Google-only account and "Change password" to everyone else. Never
        // the hash itself. This matters for usernames specifically: a handle is
        // only usable to sign in via the password form, so a Google user who
        // claims one and has no password would otherwise get a handle that
        // silently does nothing.
        hasPassword: !!user.passwordHash,
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
        // Trial / grace-window state. /me is deliberately NOT gated on this: the
        // paywall screen is rendered from this very payload, so the one endpoint
        // that tells the client it's locked has to keep answering.
        access: accessState(user),
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
