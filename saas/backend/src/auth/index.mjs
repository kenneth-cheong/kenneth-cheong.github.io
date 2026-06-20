// Auth endpoints:
//   POST /auth/google   { idToken }              -> verify Google, upsert user, issue tokens
//   POST /auth/refresh  { refreshToken }         -> new access token
//   POST /auth/signup   { email, password }      -> stage account, email a verification link
//   POST /auth/verify   { token }                -> confirm email, grant credits, issue tokens
//   POST /auth/password { email, password }      -> email/password sign-in
//   POST /auth/forgot   { email }                -> email a single-use reset link
//   POST /auth/reset    { token, password }      -> set a new password, issue tokens
//   POST /auth/resend   { email }                -> re-send the verification link
//
// We mint our OWN JWTs for every method so the rest of the API is gated by our
// authorizer and tied to the user/credits record. Google and email/password
// both resolve to one account per email address (linked via emailIndex).
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { OAuth2Client } from 'google-auth-library';
import {
  getUser, getUserByEmail, putUser, getProvision, deleteProvision, addSession, validateSession, bumpTokenVersion,
} from '../lib/dynamo.mjs';
import {
  signAccess, signRefresh, verify,
  signVerifyToken, verifyVerifyToken, signResetToken, verifyResetToken,
} from '../lib/jwt.mjs';
import { hashPassword, verifyPassword, isValidPassword } from '../lib/password.mjs';
import { sendEmail } from '../lib/email.mjs';
import { PLANS } from '../../../shared/catalog.mjs';
import { ok, badRequest, unauthorized, forbidden, tooManyRequests, parseBody, isEmail, clampStr } from '../lib/http.mjs';
import { rateLimit, AUTH_LIMITS } from '../lib/ratelimit.mjs';
import { isStaff, accountBlocked } from '../lib/admin.mjs';

const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);
const APP_ORIGIN = (process.env.APP_ORIGIN || '').replace(/\/$/, '');

// A tighter per-email budget on top of the per-IP AUTH_LIMITS, so a targeted
// brute-force/spam attempt against one address can't hide behind rotating IPs.
const EMAIL_LIMITS = [{ n: 8, seconds: 600 }, { n: 30, seconds: 86400 }];

// A friendly device label from the User-Agent, for the "Active sessions" list.
function deviceLabel(ua = '') {
  const b = /Edg/.test(ua) ? 'Edge' : /OPR|Opera/.test(ua) ? 'Opera' : /Chrome/.test(ua) ? 'Chrome'
    : /Firefox/.test(ua) ? 'Firefox' : /Safari/.test(ua) ? 'Safari' : 'Browser';
  const o = /iPhone|iPad/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Macintosh|Mac OS/.test(ua) ? 'macOS'
    : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : '';
  return o ? `${b} on ${o}` : b;
}

export const handler = async (event) => {
  const path = event.rawPath || event.requestContext?.http?.path || '';
  const body = parseBody(event);

  // These endpoints are public (pre-auth), so throttle by source IP to blunt
  // credential-stuffing / token-guessing floods.
  const ip = event.requestContext?.http?.sourceIp || 'unknown';
  const rl = await rateLimit('auth', ip, AUTH_LIMITS);
  if (!rl.allowed) return tooManyRequests(rl.retryAfter);

  const ua = event.headers?.['user-agent'] || event.headers?.['User-Agent'] || '';
  const meta = { ip, device: deviceLabel(ua) };

  if (path.endsWith('/refresh')) return handleRefresh(body);
  if (path.endsWith('/signup')) return handleSignup(body);
  if (path.endsWith('/verify')) return handleVerify(body, meta);
  if (path.endsWith('/password')) return handlePasswordLogin(body, meta);
  if (path.endsWith('/forgot')) return handleForgot(body);
  if (path.endsWith('/reset')) return handleReset(body, meta);
  if (path.endsWith('/resend')) return handleResend(body);
  return handleGoogle(body, meta);
};

// ── Shared helpers ───────────────────────────────────────────────────────────

// Apply a matching admin-provisioned invite (role / plan / starting credits set
// in the admin "Create user" UI), then consume it. Returns the (possibly
// updated) user. Safe to call for any sign-in path.
async function applyProvision(user, email) {
  const provision = await getProvision(email);
  if (!provision) return user;
  const updated = {
    ...user,
    role: provision.role || user.role,
    tier: provision.tier || user.tier,
    credits: Number.isFinite(provision.credits) ? provision.credits : user.credits,
    name: user.name || provision.name,
    updatedAt: new Date().toISOString(),
  };
  await putUser(updated);
  await deleteProvision(email);
  return updated;
}

// Register a login session and mint the token pair. Caller must have already
// rejected blocked accounts.
async function issueSession(user, meta = {}) {
  const sid = randomUUID();
  await addSession({ userId: user.userId, sid, device: meta.device, ip: meta.ip });
  return ok({
    accessToken: signAccess(user),
    refreshToken: signRefresh(user, sid),
    user: publicUser(user),
  });
}

// ── Google ───────────────────────────────────────────────────────────────────

async function handleGoogle({ idToken }, meta = {}) {
  if (!idToken) return badRequest('idToken required');

  let payload;
  try {
    const ticket = await googleClient.verifyIdToken({
      idToken,
      audience: process.env.GOOGLE_CLIENT_ID,
    });
    payload = ticket.getPayload();
  } catch {
    return unauthorized('Invalid Google token');
  }

  const userId = `google:${payload.sub}`;
  let user = await getUser(userId);

  // Account linking: a pre-existing email/password account (or a legacy record
  // under a different key) for this address becomes the canonical account, so
  // Google + password share one balance/history.
  if (!user) {
    const existing = await getUserByEmail(payload.email);
    if (existing && existing.userId !== userId) {
      user = {
        ...existing,
        googleSub: payload.sub,
        // A Google login proves email ownership.
        emailVerified: true,
        name: existing.name || payload.name,
        picture: existing.picture || payload.picture,
        updatedAt: new Date().toISOString(),
      };
      await putUser(user);
    }
  }

  if (!user) {
    // First sign-in → provision a Free account with its credit allowance.
    const now = new Date().toISOString();
    user = {
      userId,
      email: payload.email,
      name: payload.name,
      picture: payload.picture,
      tier: 'free',
      credits: PLANS.free.monthlyCredits,
      topupCredits: 0,
      emailVerified: true,
      freeCreditsGranted: true,
      stripeCustomerId: null,
      periodEnd: null,
      createdAt: now,
      updatedAt: now,
    };
    await putUser(user);
  } else if (user.picture !== payload.picture || user.name !== payload.name) {
    // Returning user → keep name/photo in sync with Google (also backfills
    // accounts created before `picture` was captured).
    user = { ...user, name: payload.name, picture: payload.picture, updatedAt: new Date().toISOString() };
    await putUser(user);
  }

  // Link an admin-provisioned account (invite-by-email): apply the role / plan /
  // starting credits set in the admin "Create user" UI, then consume the invite.
  user = await applyProvision(user, payload.email);

  // Blocked accounts can't sign in (checked after invite-linking so a paused
  // status set on the linked record is honoured).
  if (accountBlocked(user)) return forbidden({ error: 'account_suspended', status: user.status });

  return issueSession(user, meta);
}

// ── Email / password sign-up + verification ─────────────────────────────────

async function handleSignup({ email, password }) {
  email = clampStr(email, 254).trim();
  if (!isEmail(email)) return badRequest('A valid email is required.');
  if (!isValidPassword(password)) return badRequest('Password must be at least 8 characters.');

  const emailLimit = await rateLimit('authsignup', email.toLowerCase(), EMAIL_LIMITS);
  if (!emailLimit.allowed) return tooManyRequests(emailLimit.retryAfter);

  const pendingPasswordHash = hashPassword(password);
  const now = new Date().toISOString();
  const existing = await getUserByEmail(email);

  let user;
  if (existing) {
    // Account exists (Google or password). NEVER overwrite the live credentials
    // from an unauthenticated request — stage the new password and require the
    // email owner to confirm via the link. This makes signup takeover-safe and
    // doubles as a "set/replace password" flow for Google-only accounts.
    user = { ...existing, pendingPasswordHash, updatedAt: now };
    await putUser(user);
  } else {
    // Brand-new account: created unverified with NO credits. The free-tier
    // allowance is granted at verification time (freeCreditsGranted:false marks
    // it as still owed — existing/linked accounts never carry this flag).
    user = {
      userId: `local:${randomUUID()}`,
      email,
      name: email.split('@')[0],
      tier: 'free',
      credits: 0,
      topupCredits: 0,
      pendingPasswordHash,
      emailVerified: false,
      freeCreditsGranted: false,
      stripeCustomerId: null,
      periodEnd: null,
      createdAt: now,
      updatedAt: now,
    };
    await putUser(user);
  }

  await sendVerificationEmail(user);
  // Generic response either way → no account enumeration.
  return ok({ pending: true, message: 'Check your email to confirm your account.' });
}

async function sendVerificationEmail(user) {
  const token = signVerifyToken(user.userId, user.email);
  const link = `${APP_ORIGIN}/verify?token=${encodeURIComponent(token)}`;
  await sendEmail({
    to: user.email,
    subject: 'Confirm your Digimetrics account',
    text:
      `Welcome to Digimetrics!\n\n` +
      `Confirm your email to activate your account and claim your free credits:\n${link}\n\n` +
      `This link expires in 24 hours. If you didn't sign up, you can ignore this email.`,
  });
}

async function handleVerify({ token }, meta = {}) {
  if (!token) return badRequest('token required');
  let claims;
  try {
    claims = verifyVerifyToken(token);
  } catch {
    return unauthorized('This confirmation link is invalid or has expired.');
  }
  const user = await getUser(claims.sub);
  if (!user) return unauthorized('Account not found.');
  // Token is bound to the address it was issued for.
  if (claims.email && claims.email.toLowerCase() !== String(user.email || '').toLowerCase()) {
    return unauthorized('This confirmation link is no longer valid.');
  }

  const patch = { ...user, updatedAt: new Date().toISOString() };
  // Promote a staged password (signup / set-password flow) into the live hash.
  if (patch.pendingPasswordHash) {
    patch.passwordHash = patch.pendingPasswordHash;
    delete patch.pendingPasswordHash;
  }
  patch.emailVerified = true;
  // Grant the free-tier allowance exactly once, only for accounts created via
  // signup (freeCreditsGranted === false). Linked/Google accounts already have
  // their balance and never carry this flag, so they're never re-granted.
  if (patch.freeCreditsGranted === false) {
    patch.credits = PLANS.free.monthlyCredits;
    patch.freeCreditsGranted = true;
  }
  await putUser(patch);

  const finalUser = await applyProvision(patch, patch.email);
  if (accountBlocked(finalUser)) return forbidden({ error: 'account_suspended', status: finalUser.status });
  // Clicking the link proves ownership → log them straight in.
  return issueSession(finalUser, meta);
}

async function handleResend({ email }) {
  email = clampStr(email, 254).trim();
  if (!isEmail(email)) return badRequest('A valid email is required.');
  const limit = await rateLimit('authresend', email.toLowerCase(), EMAIL_LIMITS);
  if (!limit.allowed) return tooManyRequests(limit.retryAfter);
  const user = await getUserByEmail(email);
  // Only meaningful for an unverified account, but always respond generically.
  if (user && !user.emailVerified) await sendVerificationEmail(user);
  return ok({ message: 'If that account needs confirming, a new link is on its way.' });
}

// ── Email / password sign-in ────────────────────────────────────────────────

async function handlePasswordLogin({ email, password }, meta = {}) {
  email = clampStr(email, 254).trim();
  if (!isEmail(email) || typeof password !== 'string' || !password) {
    return badRequest('Email and password are required.');
  }
  const limit = await rateLimit('authlogin', email.toLowerCase(), EMAIL_LIMITS);
  if (!limit.allowed) return tooManyRequests(limit.retryAfter);

  const user = await getUserByEmail(email);
  // Same generic error whether the account is missing or the password is wrong,
  // and we still run a verify against a dummy hash to keep timing uniform.
  const okPw = user?.passwordHash
    ? verifyPassword(password, user.passwordHash)
    : (verifyPassword(password, '$$$'), false);
  if (!user || !okPw) return unauthorized('Invalid email or password.');

  if (!user.emailVerified) {
    return forbidden({ error: 'email_not_verified', message: 'Please confirm your email first — check your inbox.' });
  }
  if (accountBlocked(user)) return forbidden({ error: 'account_suspended', status: user.status });

  const linked = await applyProvision(user, user.email);
  return issueSession(linked, meta);
}

// ── Forgot / reset password ─────────────────────────────────────────────────

const hashNonce = (n) => createHash('sha256').update(String(n)).digest('hex');

async function handleForgot({ email }) {
  email = clampStr(email, 254).trim();
  if (!isEmail(email)) return badRequest('A valid email is required.');
  const limit = await rateLimit('authforgot', email.toLowerCase(), EMAIL_LIMITS);
  if (!limit.allowed) return tooManyRequests(limit.retryAfter);

  const user = await getUserByEmail(email);
  if (user) {
    // Store only a HASH of the nonce; the raw nonce lives only inside the signed
    // token we email. One outstanding reset per account; redeeming clears it.
    const jti = randomBytes(16).toString('hex');
    await putUser({ ...user, pwReset: { jti: hashNonce(jti), exp: Date.now() + 3600_000 }, updatedAt: new Date().toISOString() });
    const token = signResetToken(user.userId, jti);
    const link = `${APP_ORIGIN}/reset-password?token=${encodeURIComponent(token)}`;
    await sendEmail({
      to: user.email,
      subject: 'Reset your Digimetrics password',
      text:
        `We received a request to reset your password.\n\n` +
        `Choose a new password here:\n${link}\n\n` +
        `This link expires in 1 hour. If you didn't request this, you can safely ignore this email.`,
    });
  }
  // Always generic → no account enumeration.
  return ok({ message: 'If an account exists for that email, a reset link is on its way.' });
}

async function handleReset({ token, password }, meta = {}) {
  if (!token) return badRequest('token required');
  if (!isValidPassword(password)) return badRequest('Password must be at least 8 characters.');
  let claims;
  try {
    claims = verifyResetToken(token);
  } catch {
    return unauthorized('This reset link is invalid or has expired.');
  }
  const user = await getUser(claims.sub);
  // Single-use: the nonce must match the stored hash and not be expired.
  if (!user || !user.pwReset || user.pwReset.jti !== hashNonce(claims.jti) || (user.pwReset.exp || 0) < Date.now()) {
    return unauthorized('This reset link is invalid or has expired.');
  }

  const updated = {
    ...user,
    passwordHash: hashPassword(password),
    emailVerified: true,          // completing a reset proves email ownership
    updatedAt: new Date().toISOString(),
  };
  delete updated.pwReset;
  delete updated.pendingPasswordHash;
  await putUser(updated);
  // Invalidate all existing refresh tokens (sign out other devices) for safety,
  // then re-read so the issued tokens carry the new tokenVersion.
  await bumpTokenVersion(updated.userId);
  const fresh = await getUser(updated.userId);

  if (accountBlocked(fresh)) return forbidden({ error: 'account_suspended', status: fresh.status });
  return issueSession(fresh, meta);
}

// ── Token refresh ────────────────────────────────────────────────────────────

async function handleRefresh({ refreshToken }) {
  if (!refreshToken) return badRequest('refreshToken required');
  let claims;
  try {
    claims = verify(refreshToken);
    if (claims.typ !== 'refresh') throw new Error('not a refresh token');
  } catch {
    return unauthorized('Invalid refresh token');
  }
  const user = await getUser(claims.sub);
  if (!user) return unauthorized('User not found');
  // A paused/inactive account can't mint new access tokens — so any live
  // session dies within the access-token TTL once an admin blocks them.
  if (accountBlocked(user)) return forbidden({ error: 'account_suspended', status: user.status });
  // Reject refresh tokens issued before a "sign out everywhere" / revocation.
  if ((claims.tv || 0) !== (user.tokenVersion || 0)) return unauthorized('Session expired — please sign in again.');
  // Enforce the device cap: a session-bound token must still be registered.
  // (Legacy tokens minted before sessions existed carry no sid → grandfathered.)
  if (claims.sid && !(await validateSession(user.userId, claims.sid))) {
    return unauthorized('Signed out — this account is signed in on too many devices.');
  }
  return ok({ accessToken: signAccess(user), user: publicUser(user) });
}

function publicUser(u) {
  return {
    userId: u.userId,
    email: u.email,
    name: u.name,
    picture: u.picture,
    tier: u.tier,
    credits: (u.credits || 0) + (u.topupCredits || 0), // total spendable
    monthlyCredits: u.credits || 0,
    topupCredits: u.topupCredits || 0,
    periodEnd: u.periodEnd,
    isAdmin: isStaff(u),
    // Which sign-in methods are wired up, for the Account page UI.
    hasPassword: !!u.passwordHash,
    createdAt: u.createdAt,            // drives "is this a brand-new account" in the UI
    onboarding: u.onboarding || null,  // welcome flow / chosen goal / dismissed checklist
  };
}
