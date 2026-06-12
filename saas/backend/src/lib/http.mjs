// Shared HTTP helpers for API Gateway (HTTP API / payload v2) Lambda handlers.

const CORS = {
  'Access-Control-Allow-Origin': process.env.APP_ORIGIN || '*',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Credentials': 'true',
};

export function json(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', ...CORS },
    body: JSON.stringify(body),
  };
}

export const ok = (body) => json(200, body);
export const badRequest = (msg) => json(400, { error: msg });
export const unauthorized = (msg = 'Unauthorized') => json(401, { error: msg });

/** 402 with the upsell payload the frontend needs to render a top-up modal. */
export const paymentRequired = (payload) =>
  json(402, { error: 'insufficient_credits', ...payload });

/** 403 with the tier the tool requires, so the UI can render the upgrade CTA. */
export const tierLocked = (requiredTier) =>
  json(403, { error: 'tier_locked', requiredTier });

export const serverError = (msg = 'Internal error') => json(500, { error: msg });

export function parseBody(event) {
  if (!event.body) return {};
  try {
    return JSON.parse(event.body);
  } catch {
    return {};
  }
}

/** The JWT-authorizer puts the verified claims here on HTTP API payload v2. */
export function claims(event) {
  return event.requestContext?.authorizer?.lambda || null;
}
