// Auth endpoints:
//   POST /auth/google   { idToken }            -> verify Google, upsert user, issue tokens
//   POST /auth/refresh  { refreshToken }       -> new access token
//
// Keeps the existing Google Sign-In, but we mint our OWN JWTs so every other
// endpoint is gated by our authorizer and tied to the user/credits record.
import { OAuth2Client } from 'google-auth-library';
import { getUser, putUser, getProvision, deleteProvision } from '../lib/dynamo.mjs';
import { signAccess, signRefresh, verify } from '../lib/jwt.mjs';
import { PLANS } from '../../../shared/catalog.mjs';
import { ok, badRequest, unauthorized, tooManyRequests, parseBody } from '../lib/http.mjs';
import { rateLimit, AUTH_LIMITS } from '../lib/ratelimit.mjs';
import { isStaff } from '../lib/admin.mjs';

const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

export const handler = async (event) => {
  const path = event.rawPath || event.requestContext?.http?.path || '';
  const body = parseBody(event);

  // These endpoints are public (pre-auth), so throttle by source IP to blunt
  // credential-stuffing / token-guessing floods.
  const ip = event.requestContext?.http?.sourceIp || 'unknown';
  const rl = await rateLimit('auth', ip, AUTH_LIMITS);
  if (!rl.allowed) return tooManyRequests(rl.retryAfter);

  if (path.endsWith('/refresh')) return handleRefresh(body);
  return handleGoogle(body);
};

async function handleGoogle({ idToken }) {
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
  const provision = await getProvision(payload.email);
  if (provision) {
    user = {
      ...user,
      role: provision.role || user.role,
      tier: provision.tier || user.tier,
      credits: Number.isFinite(provision.credits) ? provision.credits : user.credits,
      name: user.name || provision.name,
      updatedAt: new Date().toISOString(),
    };
    await putUser(user);
    await deleteProvision(payload.email);
  }

  return ok({
    accessToken: signAccess(user),
    refreshToken: signRefresh(user),
    user: publicUser(user),
  });
}

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
  };
}
