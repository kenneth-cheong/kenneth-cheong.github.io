// ─────────────────────────────────────────────────────────────────────────
// Google OAuth + live data for the Integrations tools — mirrors index.html.
//
// Matches the agency app exactly:
//   • Same OAuth client id + scopes.
//   • Token exchange/refresh via the agency `googleAuth` Lambda (it holds the
//     client secret), so the SaaS needs no GOOGLE_CLIENT_SECRET.
//   • GSC: direct Search Console API. GA4 + Ads: the agency `gscIntegration`
//     and `googleAds` Lambdas (which carry the Ads developer token).
//
// Everything degrades to seeded connector data when a call fails / isn't set,
// so the product is always usable.
// ─────────────────────────────────────────────────────────────────────────
import { UPSTREAMS } from '../metering/upstreams.mjs';
import { decrypt } from './crypto.mjs';

// Same client as index.html unless overridden.
const CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '1080212071394-drtg41ou6bjm412teq626rf7dn8b41q6.apps.googleusercontent.com';
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const REDIRECT = process.env.GOOGLE_OAUTH_REDIRECT || '';
const ADS_DEV_TOKEN = process.env.GOOGLE_ADS_DEVELOPER_TOKEN || '';
const ADS_LOGIN_CID = process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID || '';

// The unified scope set index.html requests (one consent for all products).
export const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/webmasters.readonly',
  'https://www.googleapis.com/auth/indexing',
  'https://www.googleapis.com/auth/analytics.readonly',
  'https://www.googleapis.com/auth/adwords',
  'openid', 'email', 'profile',
].join(' ');

// The redirect URI is derived per-request from the API's own domain (see
// app handler) so the template needn't reference the API resource — that
// reference created a CloudFormation circular dependency. Callers pass it in;
// the env var remains a fallback for any non-request context.
export function oauthConfigured() {
  return !!CLIENT_ID;
}

export function authUrl(provider, state, redirect = REDIRECT) {
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: redirect,
    response_type: 'code',
    scope: GOOGLE_SCOPES,
    access_type: 'offline',
    include_granted_scopes: 'true',
    prompt: 'consent',
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

async function postJson(url, body) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const text = await res.text();
  let j; try { j = JSON.parse(text); } catch { j = text; }
  if (j && typeof j === 'object' && j.statusCode !== undefined && j.body !== undefined) {
    j = typeof j.body === 'string' ? JSON.parse(j.body) : j.body;
  }
  if (!res.ok) throw new Error(`${url.split('/').pop()} ${res.status}`);
  return j;
}

export async function exchangeCode(code, redirect = REDIRECT) {
  // Prefer direct exchange when a secret is configured; else reuse the agency
  // Lambda (which holds the secret), exactly as index.html's code flow does.
  if (CLIENT_SECRET) {
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code, client_id: CLIENT_ID, client_secret: CLIENT_SECRET, redirect_uri: redirect, grant_type: 'authorization_code' }),
    });
    if (!res.ok) throw new Error(`token exchange ${res.status}`);
    return res.json();
  }
  return postJson(UPSTREAMS.googleAuth, { action: 'google_token_exchange', code, client_id: CLIENT_ID, redirect_uri: redirect });
}

async function refreshAccessToken(refreshToken) {
  if (CLIENT_SECRET) {
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ refresh_token: refreshToken, client_id: CLIENT_ID, client_secret: CLIENT_SECRET, grant_type: 'refresh_token' }),
    });
    if (!res.ok) throw new Error(`token refresh ${res.status}`);
    return res.json();
  }
  return postJson(UPSTREAMS.googleAuth, { action: 'google_refresh_token', refresh_token: refreshToken, client_id: CLIENT_ID });
}

async function accessTokenFor(conn) {
  if (conn.accessToken && conn.expiresAt && Date.now() < conn.expiresAt - 60_000) return decrypt(conn.accessToken);
  const t = await refreshAccessToken(decrypt(conn.refreshToken));
  return t.access_token;
}

function dayRange(range) {
  const days = range === 'Last 7 days' ? 7 : range === 'Last 3 months' ? 90 : 28;
  const end = new Date();
  const start = new Date(end.getTime() - days * 86400_000);
  const fmt = (d) => d.toISOString().slice(0, 10);
  return { startDate: fmt(start), endDate: fmt(end) };
}
const pct = (n) => `${(n * 100).toFixed(1)}%`;
const money = (n) => `S$${Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// ── GSC: direct Search Console API (as index.html) ────────────────────────────
async function liveGsc(conn, body) {
  const token = await accessTokenFor(conn);
  const site = (body.input || conn.account || '').trim();
  if (!site) throw new Error('no site');
  const dim = ['page', 'country', 'device'].includes(body.dimension) ? body.dimension : 'query';
  const { startDate, endDate } = dayRange(body.range);
  const res = await fetch(`https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(site)}/searchAnalytics/query`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ startDate, endDate, dimensions: [dim], rowLimit: 25 }),
  });
  if (!res.ok) throw new Error(`gsc ${res.status}`);
  const data = await res.json();
  const rows = (data.rows || []).map((r) => ({
    [dim]: r.keys?.[0] ?? '—', clicks: r.clicks ?? 0, impressions: r.impressions ?? 0,
    ctr: pct(r.ctr ?? 0), position: (r.position ?? 0).toFixed(1),
  }));
  const clicks = rows.reduce((a, r) => a + (r.clicks || 0), 0);
  const impressions = rows.reduce((a, r) => a + (r.impressions || 0), 0);
  // Second pull: a day-by-day series for the trend chart (as index.html draws).
  // Best-effort — a failed trend must not sink the breakdown.
  const series = await gscSeries(token, site, startDate, endDate).catch((e) => { console.warn('gsc_series_failed', e.message); return []; });
  return { rows, series, summary: { clicks, impressions, ctr: pct(clicks / (impressions || 1)), avgPosition: rows.length ? (rows.reduce((a, r) => a + Number(r.position), 0) / rows.length).toFixed(1) : '0' } };
}

// Clicks/impressions per day for the GSC trend chart.
async function gscSeries(token, site, startDate, endDate) {
  const res = await fetch(`https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(site)}/searchAnalytics/query`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ startDate, endDate, dimensions: ['date'], rowLimit: 90 }),
  });
  if (!res.ok) throw new Error(`gsc-series ${res.status}`);
  const data = await res.json();
  return (data.rows || [])
    .map((r) => ({ date: r.keys?.[0], clicks: r.clicks ?? 0, impressions: r.impressions ?? 0 }))
    .filter((r) => r.date)
    .sort((a, b) => a.date.localeCompare(b.date));
}

// ── GA4: agency gscIntegration Lambda (ga4RunReport) ──────────────────────────
async function liveGa4(conn, body) {
  const token = await accessTokenFor(conn);
  const propertyId = (body.input || conn.account || '').replace(/^properties\//, '').trim();
  if (!propertyId) throw new Error('no property');
  const dimName = body.dimension === 'page' ? 'pagePath' : body.dimension === 'country' ? 'country' : body.dimension === 'device' ? 'deviceCategory' : 'sessionDefaultChannelGroup';
  const { startDate, endDate } = dayRange(body.range);
  const data = await postJson(UPSTREAMS.gscIntegration, {
    action: 'ga4RunReport', propertyId, access_token: token,
    payload: {
      dateRanges: [{ startDate, endDate }],
      dimensions: [{ name: dimName }],
      metrics: [{ name: 'sessions' }, { name: 'totalUsers' }, { name: 'engagedSessions' }, { name: 'conversions' }],
      limit: 25,
    },
  });
  const rows = (data.rows || []).map((r) => ({
    [body.dimension || 'channel']: r.dimensionValues?.[0]?.value ?? '—',
    sessions: Number(r.metricValues?.[0]?.value || 0),
    users: Number(r.metricValues?.[1]?.value || 0),
    engagedSessions: Number(r.metricValues?.[2]?.value || 0),
    conversions: Number(r.metricValues?.[3]?.value || 0),
  }));
  const sum = (k) => rows.reduce((a, r) => a + (r[k] || 0), 0);
  const series = await ga4Series(token, propertyId, startDate, endDate).catch((e) => { console.warn('ga4_series_failed', e.message); return []; });
  return { rows, series, summary: { sessions: sum('sessions'), users: sum('users'), engagedSessions: sum('engagedSessions'), conversions: sum('conversions') } };
}

// Sessions/users per day for the GA4 trend chart.
async function ga4Series(token, propertyId, startDate, endDate) {
  const data = await postJson(UPSTREAMS.gscIntegration, {
    action: 'ga4RunReport', propertyId, access_token: token,
    payload: {
      dateRanges: [{ startDate, endDate }],
      dimensions: [{ name: 'date' }],
      metrics: [{ name: 'sessions' }, { name: 'totalUsers' }],
      orderBys: [{ dimension: { dimensionName: 'date' } }],
      limit: 365,
    },
  });
  return (data.rows || []).map((r) => {
    const d = r.dimensionValues?.[0]?.value || ''; // GA4 returns YYYYMMDD
    return { date: `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`, sessions: Number(r.metricValues?.[0]?.value || 0), users: Number(r.metricValues?.[1]?.value || 0) };
  }).filter((r) => r.date.length === 10).sort((a, b) => a.date.localeCompare(b.date));
}

// ── Google Ads: agency googleAds Lambda (GAQL) ────────────────────────────────
async function liveAds(conn, body) {
  if (!ADS_DEV_TOKEN) throw new Error('no ads dev token');
  await accessTokenFor(conn); // ensure auth is valid (Lambda holds the actual call)
  const customerId = String(body.input || conn.account || '').replace(/[^0-9]/g, '');
  if (!customerId) throw new Error('no customer id');
  const { startDate, endDate } = dayRange(body.range);
  const query = `SELECT campaign.name, metrics.impressions, metrics.clicks, metrics.ctr, metrics.cost_micros, metrics.conversions FROM campaign WHERE segments.date BETWEEN '${startDate}' AND '${endDate}' ORDER BY metrics.cost_micros DESC LIMIT 25`;
  const data = await postJson(UPSTREAMS.googleAds, {
    query, customer_id: customerId, login_customer_id: ADS_LOGIN_CID, developer_token: ADS_DEV_TOKEN,
  });
  const results = Array.isArray(data?.results) ? data.results : (Array.isArray(data) ? data.flatMap((c) => c.results || []) : []);
  const rows = results.map((r) => {
    const cost = Number(r.metrics?.costMicros || r.metrics?.cost_micros || 0) / 1e6;
    const conv = Number(r.metrics?.conversions || 0);
    return {
      campaign: r.campaign?.name || '—',
      impressions: Number(r.metrics?.impressions || 0),
      clicks: Number(r.metrics?.clicks || 0),
      ctr: pct(Number(r.metrics?.ctr || 0)),
      cost: money(cost), conversions: conv, cpa: conv ? money(cost / conv) : '—',
    };
  });
  const cost = rows.reduce((a, r) => a + (Number(String(r.cost).replace(/[^0-9.]/g, '')) || 0), 0);
  const conv = rows.reduce((a, r) => a + (r.conversions || 0), 0);
  const series = await adsSeries(customerId, startDate, endDate).catch((e) => { console.warn('ads_series_failed', e.message); return []; });
  return { rows, series, summary: { cost: money(cost), clicks: rows.reduce((a, r) => a + r.clicks, 0), conversions: conv, cpa: conv ? money(cost / conv) : '—' } };
}

// Cost/clicks per day for the Ads trend chart — GAQL segments by date across all
// campaigns, so sum each metric per day.
async function adsSeries(customerId, startDate, endDate) {
  const query = `SELECT segments.date, metrics.cost_micros, metrics.clicks FROM campaign WHERE segments.date BETWEEN '${startDate}' AND '${endDate}'`;
  const data = await postJson(UPSTREAMS.googleAds, { query, customer_id: customerId, login_customer_id: ADS_LOGIN_CID, developer_token: ADS_DEV_TOKEN });
  const results = Array.isArray(data?.results) ? data.results : (Array.isArray(data) ? data.flatMap((c) => c.results || []) : []);
  const byDate = new Map();
  for (const r of results) {
    const date = r.segments?.date;
    if (!date) continue;
    const cur = byDate.get(date) || { date, cost: 0, clicks: 0 };
    cur.cost += Number(r.metrics?.costMicros || r.metrics?.cost_micros || 0) / 1e6;
    cur.clicks += Number(r.metrics?.clicks || 0);
    byDate.set(date, cur);
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

export async function fetchIntegration(provider, conn, body) {
  try {
    // Live when we have a usable token: a fresh browser access token (GSI token
    // flow, as index.html uses) OR a stored refresh token (server OAuth).
    const usable = conn?.connected && (conn.accessToken || (oauthConfigured() && conn.refreshToken));
    if (!usable) throw new Error('not connected');
    let res;
    if (provider === 'gsc') res = await liveGsc(conn, body);
    else if (provider === 'ga4') res = await liveGa4(conn, body);
    else if (provider === 'google-ads') res = await liveAds(conn, body);
    if (res) return { ...res, source: 'live' };
  } catch (e) {
    console.warn('integration_live_fetch_failed', provider, e.message);
  }
  // No usable token, or the live pull failed → signal "not available" so the
  // caller shows a connect gate. No seeded/demo fallback.
  return null;
}

// ── Account/property/customer discovery (for the picker) ──────────────────────
export async function listAccounts(provider, conn) {
  const token = await accessTokenFor(conn);
  if (provider === 'gsc') {
    const r = await fetch('https://www.googleapis.com/webmasters/v3/sites', { headers: { Authorization: `Bearer ${token}` } });
    const d = await r.json();
    return (d.siteEntry || [])
      .filter((s) => ['siteFullUser', 'siteOwner'].includes(s.permissionLevel))
      .map((s) => ({ id: s.siteUrl, label: s.siteUrl }));
  }
  if (provider === 'ga4') {
    const d = await postJson(UPSTREAMS.gscIntegration, { action: 'ga4ListProperties', access_token: token });
    return (d.accountSummaries || []).flatMap((a) => (a.propertySummaries || []).map((p) => ({
      id: p.property, label: `${p.displayName} (${p.property})`,
    })));
  }
  if (provider === 'google-ads') {
    const d = await postJson(UPSTREAMS.gscIntegration, { action: 'adsListCustomers', access_token: token, developerToken: ADS_DEV_TOKEN, loginCustomerId: ADS_LOGIN_CID });
    return (d.results || []).filter((r) => r.customerClient && !r.customerClient.manager).map((r) => ({
      id: String(r.customerClient.clientCustomer || '').replace('customers/', ''),
      label: `${r.customerClient.descriptiveName || 'Account'} (${String(r.customerClient.clientCustomer || '').replace('customers/', '')})`,
    }));
  }
  return [];
}

/** Best-effort default account right after connecting. */
export async function detectAccount(provider, accessToken) {
  try {
    const list = await listAccounts(provider, { accessToken, expiresAt: Date.now() + 600_000 });
    return list[0]?.id || '';
  } catch { return ''; }
}
