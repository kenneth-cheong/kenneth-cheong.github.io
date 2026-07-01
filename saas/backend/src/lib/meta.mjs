// ─────────────────────────────────────────────────────────────────────────
// Meta (Facebook / Instagram) Ads integration — Marketing API.
//
// Mirrors the google.mjs connector interface so the registry (integrations.mjs)
// can dispatch to it generically:
//   oauthConfigured() · authUrl() · exchangeCode() · fetchIntegration()
//   listAccounts() · detectAccount()
//
// ⚠️ GATING: live access to *other people's* ad accounts requires Advanced
// Access to `ads_read` via Meta App Review + Business Verification. Until then
// only users with a role on the Meta app can connect (dev/test). The connector
// is hidden in the UI until META_APP_ID + META_APP_SECRET are set (see
// oauthConfigured), so prod stays clean while approval is pending.
//
// TOKENS: Meta has no refresh token. exchangeCode() swaps the short-lived code
// token for a long-lived (~60-day) token; when it expires the user re-consents.
// See docs/meta-app-review.md.
// ─────────────────────────────────────────────────────────────────────────
import { decrypt } from './crypto.mjs';

const APP_ID = process.env.META_APP_ID || '';
const APP_SECRET = process.env.META_APP_SECRET || '';
const API_VER = process.env.META_API_VERSION || 'v21.0';
const GRAPH = `https://graph.facebook.com/${API_VER}`;

// Read-only ads access + the business scope needed to enumerate ad accounts.
const SCOPES = ['ads_read', 'business_management'];

export function oauthConfigured() {
  return !!(APP_ID && APP_SECRET);
}

export function authUrl(_provider, state, redirect) {
  const params = new URLSearchParams({
    client_id: APP_ID,
    redirect_uri: redirect,
    response_type: 'code',
    scope: SCOPES.join(','),
    state,
  });
  return `https://www.facebook.com/${API_VER}/dialog/oauth?${params.toString()}`;
}

// Swap the auth code for a short-lived token, then immediately upgrade it to a
// long-lived (~60-day) token. Returns the standard { access_token, expires_in }
// shape the OAuth callback persists — no refresh_token (Meta has none).
export async function exchangeCode(code, redirect) {
  const short = await getJson(`${GRAPH}/oauth/access_token`, {
    client_id: APP_ID, client_secret: APP_SECRET, redirect_uri: redirect, code,
  });
  if (!short.access_token) throw new Error('meta token exchange failed');
  const long = await getJson(`${GRAPH}/oauth/access_token`, {
    grant_type: 'fb_exchange_token', client_id: APP_ID, client_secret: APP_SECRET,
    fb_exchange_token: short.access_token,
  }).catch(() => short); // fall back to the short token if the swap fails
  return { access_token: long.access_token || short.access_token, expires_in: long.expires_in || short.expires_in || 3600, scope: SCOPES.join(',') };
}

// Meta tokens don't refresh. Use the stored long-lived token until it expires;
// once stale, throw so the caller surfaces a reconnect gate.
function accessTokenFor(conn) {
  if (conn.accessToken && (!conn.expiresAt || Date.now() < conn.expiresAt - 60_000)) return decrypt(conn.accessToken);
  throw new Error('meta token expired — reconnect under Integrations');
}

async function getJson(url, params) {
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`${url}?${qs}`);
  const j = await res.json().catch(() => ({}));
  if (!res.ok || j.error) throw new Error(j.error?.message || `meta ${res.status}`);
  return j;
}

function dayRange(range, customStart, customEnd) {
  const fmt = (d) => d.toISOString().slice(0, 10);
  if (range === 'Custom' && customStart && customEnd) {
    const s = String(customStart).slice(0, 10), e = String(customEnd).slice(0, 10);
    return s <= e ? { since: s, until: e } : { since: e, until: s };
  }
  const days = range === 'Last 7 days' ? 7 : range === 'Last 3 months' ? 90 : 28;
  const end = new Date();
  const start = new Date(end.getTime() - days * 86400_000);
  return { since: fmt(start), until: fmt(end) };
}
function comparisonRange(range, code, customStart, customEnd) {
  const fmt = (d) => d.toISOString().slice(0, 10);
  const cur = dayRange(range, customStart, customEnd);
  const start = new Date(cur.since), end = new Date(cur.until);
  if (code === 'prev_year') return { since: fmt(new Date(start.getTime() - 365 * 86400_000)), until: fmt(new Date(end.getTime() - 365 * 86400_000)) };
  const durationMs = end.getTime() - start.getTime();
  const prevEnd = new Date(start.getTime() - 86400_000);
  const prevStart = new Date(prevEnd.getTime() - durationMs);
  return { since: fmt(prevStart), until: fmt(prevEnd) };
}
function compareCode(c) {
  const s = String(c || '').toLowerCase();
  if (s.includes('year')) return 'prev_year';
  if (s.includes('period') || s === 'previous') return 'prev_period';
  return 'none';
}
const pct = (n) => `${(Number(n) * 100).toFixed(1)}%`;
const money = (n) => Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pctChange = (cur, prev) => {
  const c = Number(cur) || 0, p = Number(prev) || 0;
  return p === 0 ? null : ((c - p) / p) * 100;
};

// Sum the conversion-like actions Meta returns in the `actions` array.
function conversionsFrom(actions) {
  if (!Array.isArray(actions)) return 0;
  return actions
    .filter((a) => /lead|purchase|complete_registration|conversion|submit_application/i.test(a.action_type || ''))
    .reduce((s, a) => s + Number(a.value || 0), 0);
}

function actId(raw) {
  const id = String(raw || '').replace(/^act_/, '').replace(/[^0-9]/g, '');
  return id ? `act_${id}` : '';
}

// Drill-down level → the insights `level` + the row's name field.
const META_LEVELS = {
  campaign: { key: 'campaign', level: 'campaign', nameField: 'campaign_name' },
  adset: { key: 'adSet', level: 'adset', nameField: 'adset_name' },
  ad: { key: 'ad', level: 'ad', nameField: 'ad_name' },
};
function metaLevel(body) {
  const s = String(body.level || '').toLowerCase().replace(/\s+/g, '');
  return META_LEVELS[s] || META_LEVELS.campaign;
}
// Optional breakdown dimension → Meta's `breakdowns` param (null = none).
const META_BREAKDOWNS = {
  platform: 'publisher_platform', placement: 'platform_position', device: 'impression_device',
  country: 'country', region: 'region', 'age & gender': 'age,gender', 'age&gender': 'age,gender',
  hour: 'hourly_stats_aggregated_by_advertiser_time_zone',
};
function metaBreakdown(body) {
  return META_BREAKDOWNS[String(body.breakdown || '').toLowerCase()] || null;
}
function metaSegment(r, bd) {
  if (bd === 'age,gender') return `${r.age || '?'} · ${r.gender || '?'}`;
  return r[bd] ?? '—';
}

// Insights at the chosen level (+ optional breakdown) → breakdown rows + totals.
async function insightsBreakdown(account, token, since, until, body = {}) {
  const lv = metaLevel(body);
  const bd = metaBreakdown(body);
  const params = {
    access_token: token, level: lv.level,
    fields: `${lv.nameField},spend,clicks,impressions,ctr,actions`,
    time_range: JSON.stringify({ since, until }), limit: bd ? '100' : '25',
  };
  if (bd) params.breakdowns = bd;
  const data = await getJson(`${GRAPH}/${account}/insights`, params);
  const rows = (data.data || []).map((r) => {
    const spend = Number(r.spend || 0);
    const conv = conversionsFrom(r.actions);
    const row = {
      [lv.key]: r[lv.nameField] || '—',
      impressions: Number(r.impressions || 0),
      clicks: Number(r.clicks || 0),
      ctr: pct(Number(r.ctr || 0) / 100), // Meta ctr is already a percentage
      spend: money(spend), conversions: conv, cpa: conv ? money(spend / conv) : '—',
    };
    if (bd) row.segment = metaSegment(r, bd);
    return row;
  });
  const sum = (k) => rows.reduce((a, r) => a + (Number(String(r[k]).replace(/[^0-9.]/g, '')) || 0), 0);
  return { rows, raw: { spend: sum('spend'), clicks: rows.reduce((a, r) => a + r.clicks, 0), conversions: rows.reduce((a, r) => a + r.conversions, 0) } };
}

// Per-day spend/clicks for the trend chart.
async function insightsSeries(account, token, since, until) {
  const data = await getJson(`${GRAPH}/${account}/insights`, {
    access_token: token, level: 'account', fields: 'spend,clicks',
    time_range: JSON.stringify({ since, until }), time_increment: '1', limit: '90',
  });
  return (data.data || [])
    .map((r) => ({ date: r.date_start, spend: Number(r.spend || 0), clicks: Number(r.clicks || 0) }))
    .filter((r) => r.date)
    .sort((a, b) => a.date.localeCompare(b.date));
}

async function insightsDeltas(account, token, body, cur) {
  const code = compareCode(body.compare);
  if (code === 'none') return null;
  const { since, until } = comparisonRange(body.range, code, body.startDate, body.endDate);
  // Compare like-for-like at the same level, but without the breakdown split.
  const prev = (await insightsBreakdown(account, token, since, until, { level: body.level })).raw;
  const curCpa = cur.conversions ? cur.spend / cur.conversions : 0;
  const prevCpa = prev.conversions ? prev.spend / prev.conversions : 0;
  return { spend: pctChange(cur.spend, prev.spend), clicks: pctChange(cur.clicks, prev.clicks), conversions: pctChange(cur.conversions, prev.conversions), cpa: pctChange(curCpa, prevCpa) };
}

export async function fetchIntegration(_provider, conn, body) {
  try {
    if (!conn?.connected || !conn.accessToken) throw new Error('not connected');
    const token = accessTokenFor(conn);
    const account = actId(body.input || conn.account);
    if (!account) throw new Error('no ad account');
    const { since, until } = dayRange(body.range, body.startDate, body.endDate);
    const main = await insightsBreakdown(account, token, since, until, body);
    const series = await insightsSeries(account, token, since, until).catch((e) => { console.warn('meta_series_failed', e.message); return []; });
    const deltas = await insightsDeltas(account, token, body, main.raw).catch((e) => { console.warn('meta_compare_failed', e.message); return null; });
    const { spend, clicks, conversions } = main.raw;
    return { rows: main.rows, series, deltas, summary: { cost: money(spend), clicks, conversions, cpa: conversions ? money(spend / conversions) : '—' }, source: 'live' };
  } catch (e) {
    console.warn('meta_live_fetch_failed', e.message);
    return null;
  }
}

export async function listAccounts(_provider, conn) {
  const token = accessTokenFor(conn);
  const data = await getJson(`${GRAPH}/me/adaccounts`, { access_token: token, fields: 'account_id,name,currency', limit: '200' });
  return (data.data || []).map((a) => ({
    id: `act_${a.account_id}`,
    label: `${a.name || 'Ad account'} (${a.account_id})${a.currency ? ' · ' + a.currency : ''}`,
  }));
}

// Runs in the OAuth callback with a raw (un-encrypted) token; accessTokenFor()
// calls decrypt(), which passes plaintext through unchanged (see crypto.mjs).
export async function detectAccount(_provider, accessToken) {
  try {
    const list = await listAccounts('meta-ads', { accessToken, expiresAt: Date.now() + 600_000 });
    return list[0]?.id || '';
  } catch { return ''; }
}
