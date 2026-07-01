// ─────────────────────────────────────────────────────────────────────────
// Connector registry — maps each integration provider to its connector module
// so the app handler and metering gateway can dispatch generically instead of
// importing google.mjs directly.
//
// A "family" shares a single OAuth consent: Google's one sign-in connects all
// three of gsc/ga4/google-ads; Meta and LinkedIn each have a single source.
// Adding a connector = a new lib/<provider>.mjs (mirroring google.mjs's
// interface) + an entry here + a catalog tool/INTEGRATIONS row.
// ─────────────────────────────────────────────────────────────────────────
import * as google from './google.mjs';
import * as meta from './meta.mjs';
import * as linkedin from './linkedin.mjs';

const CONNECTORS = {
  gsc: { module: google, family: 'google' },
  ga4: { module: google, family: 'google' },
  'google-ads': { module: google, family: 'google' },
  'meta-ads': { module: meta, family: 'meta' },
  'linkedin-ads': { module: linkedin, family: 'linkedin' },
};

// Providers connected by one consent, keyed by family. Used by the OAuth
// callback to mark every source in a family connected after a single sign-in.
const FAMILY_PROVIDERS = {
  google: ['gsc', 'ga4', 'google-ads'],
  meta: ['meta-ads'],
  linkedin: ['linkedin-ads'],
};

export function connectorFor(provider) {
  return CONNECTORS[provider]?.module || null;
}
export function familyOf(provider) {
  return CONNECTORS[provider]?.family || null;
}
export function providersInFamilyOf(provider) {
  return FAMILY_PROVIDERS[familyOf(provider)] || (provider ? [provider] : []);
}

/** Is this provider's OAuth wired up on this deployment (env vars present)? */
export function connectorConfigured(provider) {
  const m = connectorFor(provider);
  return !!(m && m.oauthConfigured && m.oauthConfigured());
}

// ── Thin dispatch wrappers (keep call sites provider-agnostic) ───────────────
export function authorizeUrl(provider, state, redirect) {
  return connectorFor(provider).authUrl(provider, state, redirect);
}
export function exchangeCodeFor(provider, code, redirect) {
  return connectorFor(provider).exchangeCode(code, redirect);
}
export function listAccountsFor(provider, conn) {
  return connectorFor(provider).listAccounts(provider, conn);
}
export function detectAccountFor(provider, accessToken) {
  return connectorFor(provider).detectAccount(provider, accessToken);
}
// Optional — the signed-in account's email/label; not every connector exposes it.
export function detectEmailFor(provider, accessToken) {
  const m = connectorFor(provider);
  return m?.detectEmail ? m.detectEmail(accessToken) : Promise.resolve('');
}
// GA4-only: which extra metrics are compatible with a chosen breakdown dimension.
export function ga4CompatibleMetrics(conn, dimension) {
  return google.ga4CompatibleMetrics(conn, dimension);
}
export function fetchIntegrationFor(provider, conn, body) {
  return connectorFor(provider).fetchIntegration(provider, conn, body);
}
