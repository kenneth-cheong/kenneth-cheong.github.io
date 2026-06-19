// ─────────────────────────────────────────────────────────────────────────
// Google integration helpers (GSC / GA4 / Google Ads).
//
// Live data is fetched from the Google APIs with the user's stored OAuth token
// (see backend/src/lib/google.mjs). When an account isn't connected — or a live
// pull fails — the tools return a "connect your account" gate. There is no
// demo / seeded-data fallback.
// ─────────────────────────────────────────────────────────────────────────

const LABEL = { gsc: 'Search Console', ga4: 'GA4', 'google-ads': 'Google Ads', 'meta-ads': 'Meta Ads', 'linkedin-ads': 'LinkedIn Ads' };

/** Compact one-line status the chatbot can read for a connected account. States
 *  what's connected without fabricating metrics — live numbers come from running
 *  the relevant tool against the Google API. */
export function integrationSummary(provider, account) {
  const name = LABEL[provider];
  if (!name) return '';
  const who = account ? ` (${account})` : '';
  return `${name} connected${who} — run the ${name} tool for live last-28-day metrics.`;
}
