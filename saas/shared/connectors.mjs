// ─────────────────────────────────────────────────────────────────────────
// Google integration connectors (GSC / GA4 / Google Ads).
//
// In PRODUCTION these call the Google APIs with the user's stored OAuth token
// (Search Console API, GA4 Data API, Google Ads API). Until those OAuth scopes
// are wired, they return realistic SEEDED data — deterministic per (account,
// range) — so the tools, the run history and the assistant are fully usable.
// Swap the bodies of gscData / ga4Data / googleAdsData for real API calls and
// nothing else needs to change.
// ─────────────────────────────────────────────────────────────────────────

/** Tiny deterministic PRNG seeded from a string, so repeat pulls are stable. */
function rng(str) {
  let h = 2166136261;
  for (const c of String(str || 'seed')) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
  return () => { h = (Math.imul(h, 1103515245) + 12345) >>> 0; return h / 2 ** 32; };
}
const days = (r) => (r === 'Last 7 days' ? 7 : r === 'Last 3 months' ? 90 : 28);
const pct = (n) => `${(n * 100).toFixed(1)}%`;
const money = (n) => `S$${Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const sum = (arr, k) => arr.reduce((a, x) => a + (x[k] || 0), 0);

const GSC_QUERIES = ['self storage singapore', 'storage units', 'cheap storage', 'mini storage', 'business storage', 'wine storage', 'document storage', 'storage near me', 'climate controlled storage', 'storage rental'];
const GA4_CHANNELS = ['Organic Search', 'Direct', 'Paid Search', 'Referral', 'Organic Social', 'Email'];
const ADS_CAMPAIGNS = ['Brand - Search', 'Generic - Search', 'Performance Max', 'Display - Remarketing', 'Competitor - Search'];

export function gscData(body) {
  const r = rng((body.input || '') + (body.range || '') + (body.dimension || ''));
  const d = days(body.range);
  const dim = body.dimension || 'query';
  const labels = dim === 'query' ? GSC_QUERIES
    : dim === 'page' ? GSC_QUERIES.map((_, i) => `/page-${i + 1}`)
    : dim === 'country' ? ['Singapore', 'Malaysia', 'Indonesia', 'Australia', 'India', 'United States']
    : ['Mobile', 'Desktop', 'Tablet'];
  const rows = labels.map((label) => {
    const impressions = Math.round((400 + r() * 9000) * (d / 28));
    const ctr = 0.01 + r() * 0.12;
    const clicks = Math.round(impressions * ctr);
    return { [dim]: label, clicks, impressions, ctr: pct(clicks / impressions || 0), position: (1 + r() * 30).toFixed(1) };
  }).sort((a, b) => b.clicks - a.clicks);
  const clicks = sum(rows, 'clicks'); const impressions = sum(rows, 'impressions');
  return {
    rows,
    summary: { clicks, impressions, ctr: pct(clicks / impressions || 0), avgPosition: (sum(rows.map((x) => ({ p: +x.position })), 'p') / rows.length).toFixed(1) },
  };
}

export function ga4Data(body) {
  const r = rng((body.input || '') + (body.range || '') + (body.dimension || ''));
  const d = days(body.range);
  const dim = body.dimension || 'channel';
  const labels = dim === 'channel' ? GA4_CHANNELS
    : dim === 'page' ? ['/', '/personal-storage', '/business-storage', '/pricing', '/locations', '/contact']
    : dim === 'country' ? ['Singapore', 'Malaysia', 'Indonesia', 'Australia', 'India']
    : ['Mobile', 'Desktop', 'Tablet'];
  const rows = labels.map((label) => {
    const sessions = Math.round((300 + r() * 6000) * (d / 28));
    const users = Math.round(sessions * (0.7 + r() * 0.25));
    const engaged = Math.round(sessions * (0.4 + r() * 0.45));
    const conversions = Math.round(sessions * (0.005 + r() * 0.03));
    return { [dim]: label, sessions, users, engagedSessions: engaged, conversions };
  }).sort((a, b) => b.sessions - a.sessions);
  return {
    rows,
    summary: { sessions: sum(rows, 'sessions'), users: sum(rows, 'users'), engagedSessions: sum(rows, 'engagedSessions'), conversions: sum(rows, 'conversions') },
  };
}

export function googleAdsData(body) {
  const r = rng((body.input || '') + (body.range || ''));
  const d = days(body.range);
  const rows = ADS_CAMPAIGNS.map((campaign) => {
    const impressions = Math.round((1000 + r() * 40000) * (d / 28));
    const ctr = 0.02 + r() * 0.09;
    const clicks = Math.round(impressions * ctr);
    const cost = +(clicks * (0.6 + r() * 2.4)).toFixed(2);
    const conversions = Math.round(clicks * (0.02 + r() * 0.08));
    return { campaign, impressions, clicks, ctr: pct(ctr), cost: money(cost), conversions, cpa: conversions ? money(cost / conversions) : '—', _cost: cost, _conv: conversions };
  }).sort((a, b) => b._cost - a._cost);
  const cost = rows.reduce((a, x) => a + x._cost, 0);
  const conversions = sum(rows, '_conv');
  rows.forEach((x) => { delete x._cost; delete x._conv; });
  return {
    rows,
    summary: { cost: money(cost), clicks: sum(rows, 'clicks'), conversions, cpa: conversions ? money(cost / conversions) : '—' },
  };
}

const BY = { gsc: gscData, ga4: ga4Data, 'google-ads': googleAdsData };

/** Full tool result for an integration pull → { rows, summary }. */
export function integrationResult(provider, body) {
  const fn = BY[provider];
  return fn ? fn(body) : { rows: [], summary: {} };
}

/** Compact one-line summary string the chatbot can read for a connected account. */
export function integrationSummary(provider, account) {
  const body = { input: account || 'demo', range: 'Last 28 days', dimension: provider === 'ga4' ? 'channel' : 'query' };
  const s = integrationResult(provider, body).summary;
  if (provider === 'gsc') return `Search Console (${account}, last 28d): ${s.clicks.toLocaleString()} clicks, ${s.impressions.toLocaleString()} impressions, ${s.ctr} CTR, avg position ${s.avgPosition}.`;
  if (provider === 'ga4') return `GA4 (${account}, last 28d): ${s.sessions.toLocaleString()} sessions, ${s.users.toLocaleString()} users, ${s.conversions.toLocaleString()} conversions.`;
  if (provider === 'google-ads') return `Google Ads (${account}, last 28d): ${s.cost} spend, ${s.clicks.toLocaleString()} clicks, ${s.conversions} conversions, ${s.cpa} CPA.`;
  return '';
}
