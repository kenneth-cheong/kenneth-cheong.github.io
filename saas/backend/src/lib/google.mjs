// ─────────────────────────────────────────────────────────────────────────
// Google OAuth + live data fetchers for the Integrations tools.
//
//   Connect flow:  authUrl() → user consents → exchangeCode() → store refresh
//   token on the user.  Per run:  fetchIntegration() refreshes an access token
//   and calls the live Google API, falling back to the seeded connectors if
//   OAuth isn't configured, the user isn't connected, or the API call fails.
//
// Required env (set in template.yaml / SSM):
//   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_OAUTH_REDIRECT
//   GOOGLE_ADS_DEVELOPER_TOKEN (optional — Ads falls back without it)
// ─────────────────────────────────────────────────────────────────────────
import { integrationResult } from '../../../shared/connectors.mjs';

const SCOPES = {
  gsc: 'https://www.googleapis.com/auth/webmasters.readonly',
  ga4: 'https://www.googleapis.com/auth/analytics.readonly',
  'google-ads': 'https://www.googleapis.com/auth/adwords',
};

export function oauthConfigured() {
  return !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && process.env.GOOGLE_OAUTH_REDIRECT);
}

export function authUrl(provider, state) {
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    redirect_uri: process.env.GOOGLE_OAUTH_REDIRECT,
    response_type: 'code',
    scope: `openid email ${SCOPES[provider] || ''}`.trim(),
    access_type: 'offline',
    include_granted_scopes: 'true',
    prompt: 'consent',
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

export async function exchangeCode(code) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      redirect_uri: process.env.GOOGLE_OAUTH_REDIRECT,
      grant_type: 'authorization_code',
    }),
  });
  if (!res.ok) throw new Error(`token exchange failed: ${res.status}`);
  return res.json(); // { access_token, refresh_token, expires_in, scope, ... }
}

async function refreshAccessToken(refreshToken) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      grant_type: 'refresh_token',
    }),
  });
  if (!res.ok) throw new Error(`token refresh failed: ${res.status}`);
  return res.json(); // { access_token, expires_in, ... }
}

/** A valid access token for a connection (refreshes via the stored refresh token). */
async function accessTokenFor(conn) {
  if (conn.accessToken && conn.expiresAt && Date.now() < conn.expiresAt - 60_000) return conn.accessToken;
  const t = await refreshAccessToken(conn.refreshToken);
  return t.access_token;
}

// Date helpers — Google APIs want YYYY-MM-DD ranges.
function dayRange(range) {
  const days = range === 'Last 7 days' ? 7 : range === 'Last 3 months' ? 90 : 28;
  const end = new Date();
  const start = new Date(end.getTime() - days * 86400_000);
  const fmt = (d) => d.toISOString().slice(0, 10);
  return { startDate: fmt(start), endDate: fmt(end) };
}
const pct = (n) => `${(n * 100).toFixed(1)}%`;

// ── GSC: Search Console Search Analytics ──────────────────────────────────────
async function liveGsc(conn, body) {
  const token = await accessTokenFor(conn);
  const site = (body.input || conn.account || '').trim();
  if (!site) throw new Error('no site');
  const dim = body.dimension === 'page' ? 'page' : body.dimension === 'country' ? 'country' : body.dimension === 'device' ? 'device' : 'query';
  const { startDate, endDate } = dayRange(body.range);
  const res = await fetch(`https://searchconsole.googleapis.com/webmasters/v3/sites/${encodeURIComponent(site)}/searchAnalytics/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ startDate, endDate, dimensions: [dim], rowLimit: 25 }),
  });
  if (!res.ok) throw new Error(`gsc ${res.status}`);
  const data = await res.json();
  const rows = (data.rows || []).map((r) => ({
    [dim]: r.keys?.[0] ?? '—',
    clicks: r.clicks ?? 0,
    impressions: r.impressions ?? 0,
    ctr: pct(r.ctr ?? 0),
    position: (r.position ?? 0).toFixed(1),
  }));
  const clicks = rows.reduce((a, r) => a + (r.clicks || 0), 0);
  const impressions = rows.reduce((a, r) => a + (r.impressions || 0), 0);
  return { rows, summary: { clicks, impressions, ctr: pct(clicks / (impressions || 1)), avgPosition: rows.length ? (rows.reduce((a, r) => a + Number(r.position), 0) / rows.length).toFixed(1) : '0' } };
}

// ── GA4: Analytics Data API runReport ─────────────────────────────────────────
async function liveGa4(conn, body) {
  const token = await accessTokenFor(conn);
  const property = (body.input || conn.account || '').replace(/^properties\//, '').trim();
  if (!property) throw new Error('no property');
  const dimName = body.dimension === 'page' ? 'pagePath' : body.dimension === 'country' ? 'country' : body.dimension === 'device' ? 'deviceCategory' : 'sessionDefaultChannelGroup';
  const { startDate, endDate } = dayRange(body.range);
  const res = await fetch(`https://analyticsdata.googleapis.com/v1beta/properties/${property}:runReport`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      dateRanges: [{ startDate, endDate }],
      dimensions: [{ name: dimName }],
      metrics: [{ name: 'sessions' }, { name: 'totalUsers' }, { name: 'engagedSessions' }, { name: 'conversions' }],
      limit: 25,
    }),
  });
  if (!res.ok) throw new Error(`ga4 ${res.status}`);
  const data = await res.json();
  const rows = (data.rows || []).map((r) => ({
    [body.dimension || 'channel']: r.dimensionValues?.[0]?.value ?? '—',
    sessions: Number(r.metricValues?.[0]?.value || 0),
    users: Number(r.metricValues?.[1]?.value || 0),
    engagedSessions: Number(r.metricValues?.[2]?.value || 0),
    conversions: Number(r.metricValues?.[3]?.value || 0),
  }));
  const sum = (k) => rows.reduce((a, r) => a + (r[k] || 0), 0);
  return { rows, summary: { sessions: sum('sessions'), users: sum('users'), engagedSessions: sum('engagedSessions'), conversions: sum('conversions') } };
}

// ── Google Ads: GAQL searchStream (needs an approved developer token) ─────────
async function liveAds(conn, body) {
  const devToken = process.env.GOOGLE_ADS_DEVELOPER_TOKEN;
  if (!devToken) throw new Error('no ads dev token');
  const token = await accessTokenFor(conn);
  const customerId = String(body.input || conn.account || '').replace(/[^0-9]/g, '');
  if (!customerId) throw new Error('no customer id');
  const dur = body.range === 'Last 7 days' ? 'LAST_7_DAYS' : body.range === 'Last 3 months' ? 'LAST_90_DAYS' : 'LAST_30_DAYS';
  const query = `SELECT campaign.name, metrics.impressions, metrics.clicks, metrics.ctr, metrics.cost_micros, metrics.conversions FROM campaign WHERE segments.date DURING ${dur} ORDER BY metrics.cost_micros DESC LIMIT 25`;
  const res = await fetch(`https://googleads.googleapis.com/v17/customers/${customerId}/googleAds:searchStream`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'developer-token': devToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  if (!res.ok) throw new Error(`ads ${res.status}`);
  const chunks = await res.json();
  const results = (Array.isArray(chunks) ? chunks : [chunks]).flatMap((c) => c.results || []);
  const money = (m) => `S$${(Number(m || 0) / 1e6).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const rows = results.map((r) => {
    const cost = Number(r.metrics?.costMicros || 0) / 1e6;
    const conv = Number(r.metrics?.conversions || 0);
    return {
      campaign: r.campaign?.name || '—',
      impressions: Number(r.metrics?.impressions || 0),
      clicks: Number(r.metrics?.clicks || 0),
      ctr: pct(Number(r.metrics?.ctr || 0)),
      cost: money(r.metrics?.costMicros),
      conversions: conv,
      cpa: conv ? `S$${(cost / conv).toFixed(2)}` : '—',
    };
  });
  const cost = results.reduce((a, r) => a + Number(r.metrics?.costMicros || 0) / 1e6, 0);
  const conv = rows.reduce((a, r) => a + (r.conversions || 0), 0);
  return { rows, summary: { cost: money(cost * 1e6), clicks: rows.reduce((a, r) => a + r.clicks, 0), conversions: conv, cpa: conv ? `S$${(cost / conv).toFixed(2)}` : '—' } };
}

/**
 * Live integration data, with a graceful fallback to seeded connector data so
 * the product stays usable when OAuth isn't configured or a call fails.
 */
export async function fetchIntegration(provider, conn, body) {
  try {
    if (!oauthConfigured() || !conn?.refreshToken) throw new Error('not connected');
    if (provider === 'gsc') return await liveGsc(conn, body);
    if (provider === 'ga4') return await liveGa4(conn, body);
    if (provider === 'google-ads') return await liveAds(conn, body);
  } catch (e) {
    console.warn('integration_live_fallback', provider, e.message);
  }
  return integrationResult(provider, body);
}

/** Best-effort: detect a default account id right after connecting. */
export async function detectAccount(provider, accessToken) {
  try {
    if (provider === 'gsc') {
      const r = await fetch('https://searchconsole.googleapis.com/webmasters/v3/sites', { headers: { Authorization: `Bearer ${accessToken}` } });
      const d = await r.json();
      return (d.siteEntry || []).find((s) => s.permissionLevel !== 'siteUnverifiedUser')?.siteUrl || (d.siteEntry || [])[0]?.siteUrl || '';
    }
  } catch { /* ignore */ }
  return '';
}
