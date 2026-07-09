import { describe, it, expect } from 'vitest';
import { parseAccessLog } from '../src/lib/platform-usage.mjs';

// Header + rows in the exact CloudFront/Amplify access-log shape observed live:
// comma-separated, %20-encoded spaces, backslash-escaped parens/equals.
const HEADER = 'date,time,x-edge-location,sc-bytes,c-ip,cs-method,cs\\(Host\\),cs-uri-stem,sc-status,cs\\(Referer\\),cs\\(User-Agent\\),cs-uri-query,cs\\(Cookie\\),x-edge-result-type,x-edge-request-id,x-host-header,cs-protocol,cs-bytes,time-taken,x-forwarded-for,ssl-protocol,ssl-cipher,x-edge-response-result-type,cs-protocol-version,fle-status,fle-encrypted-fields,c-port,time-to-first-byte,x-edge-detailed-result-type,sc-content-type,sc-content-len,sc-range-start,sc-range-end';

const CHROME_MAC = 'Mozilla/5.0%20\\(Macintosh;%20Intel%20Mac%20OS%20X%2010_15_7\\)%20AppleWebKit/537.36%20\\(KHTML%20like%20Gecko\\)%20Chrome/149.0.0.0%20Safari/537.36';
// Amplify strips field-separator commas, so the live UA reads "KHTML like Gecko".
const SAFARI_IPHONE = 'Mozilla/5.0%20\\(iPhone;%20CPU%20iPhone%20OS%2017_0%20like%20Mac%20OS%20X\\)%20AppleWebKit/605.1.15%20\\(KHTML%20like%20Gecko\\)%20Version/17.0%20Mobile/15E148%20Safari/604.1';

// Build a row from a sparse map of column-name → value (others default to '-').
function row(vals) {
  const cols = HEADER.split(',').map((h) => h.replace(/\\(.)/g, '$1'));
  return cols.map((c) => (c in vals ? vals[c] : '-')).join(',');
}

const CSV = [
  HEADER,
  row({ 'x-edge-location': 'SIN3-P3', 'sc-bytes': '1667', 'cs-uri-stem': '/', 'sc-status': '200', 'cs(Referer)': '-', 'cs(User-Agent)': CHROME_MAC, 'x-edge-result-type': 'Miss' }),
  row({ 'x-edge-location': 'SIN2-C1', 'sc-bytes': '11463', 'cs-uri-stem': '/assets/index-Caj95zKi.css', 'sc-status': '200', 'cs(Referer)': 'https://platform.digimetrics.ai/', 'cs(User-Agent)': CHROME_MAC, 'x-edge-result-type': 'Hit' }),
  row({ 'x-edge-location': 'LHR62-P1', 'sc-bytes': '5000', 'cs-uri-stem': '/admin', 'sc-status': '200', 'cs(Referer)': 'https://www.google.com/', 'cs(User-Agent)': SAFARI_IPHONE, 'x-edge-result-type': 'Hit' }),
  row({ 'x-edge-location': 'SIN3-P3', 'sc-bytes': '900', 'cs-uri-stem': '/admin', 'sc-status': '404', 'cs(Referer)': '-', 'cs(User-Agent)': CHROME_MAC, 'x-edge-result-type': 'Error' }),
  row({ 'x-edge-location': 'JFK5-P2', 'sc-bytes': '4000', 'cs-uri-stem': '/dashboard', 'sc-status': '500', 'cs(Referer)': 'https://platform.digimetrics.ai/admin', 'cs(User-Agent)': CHROME_MAC, 'x-edge-result-type': 'Miss' }),
  // Self-referral (in-app nav) + AWS infra host — both must be excluded from referrers.
  row({ 'x-edge-location': 'SIN3-P3', 'sc-bytes': '300', 'cs-uri-stem': '/history', 'sc-status': '200', 'cs(Referer)': 'https://platform.digimetrics.ai/usage', 'cs(User-Agent)': CHROME_MAC, 'x-edge-result-type': 'Hit' }),
  row({ 'x-edge-location': 'SIN3-P3', 'sc-bytes': '300', 'cs-uri-stem': '/api', 'sc-status': '200', 'cs(Referer)': 'https://h07tay1xvi.execute-api.ap-southeast-1.amazonaws.com/', 'cs(User-Agent)': CHROME_MAC, 'x-edge-result-type': 'Miss' }),
].join('\n') + '\n';

const range = { from: new Date('2026-07-08T00:00:00Z'), to: new Date('2026-07-09T00:00:00Z') };

describe('parseAccessLog', () => {
  const out = parseAccessLog(CSV, false, range, { selfDomain: 'digimetrics.ai' });

  it('counts every data row', () => {
    expect(out.rows).toBe(7);
  });

  it('excludes static assets from top pages, keeps real navigations', () => {
    const names = out.topPages.map((p) => p.name);
    expect(names).not.toContain('/assets/index-Caj95zKi.css');
    const admin = out.topPages.find((p) => p.name === '/admin');
    expect(admin.count).toBe(2); // /admin hit twice
    expect(names).toContain('/');
    expect(names).toContain('/dashboard');
  });

  it('buckets status codes', () => {
    expect(out.status['2xx']).toBe(5);
    expect(out.status['4xx']).toBe(1);
    expect(out.status['5xx']).toBe(1);
  });

  it('computes cache-hit ratio from result types (Hit vs Miss, ignores Error)', () => {
    // 3 Hit, 3 Miss → 0.5 (the 'Error' row counts as neither)
    expect(out.cacheHitRatio).toBeCloseTo(0.5, 5);
  });

  it('keeps external referrer hosts and drops self-referrals, AWS infra, and direct hits', () => {
    const refs = out.topReferrers.map((r) => r.name);
    expect(refs).toContain('www.google.com');
    // Self-referral (own domain / subdomain) and AWS infra hosts are excluded.
    expect(refs).not.toContain('platform.digimetrics.ai');
    expect(refs.some((r) => /amazonaws\.com$/.test(r))).toBe(false);
    expect(out.topReferrers.find((r) => r.name === '-')).toBeUndefined();
  });

  it('classifies devices and browsers from the user-agent', () => {
    const dev = Object.fromEntries(out.devices.map((d) => [d.name, d.count]));
    expect(dev.Mobile).toBe(1);   // the iPhone row
    expect(dev.Desktop).toBe(6);
    const br = Object.fromEntries(out.browsers.map((b) => [b.name, b.count]));
    expect(br.Chrome).toBe(6);
    expect(br.Safari).toBe(1);
  });

  it('maps edge POP codes to regions', () => {
    const geo = Object.fromEntries(out.edgeGeo.map((g) => [g.name, g.count]));
    expect(geo.Singapore).toBe(5); // all requests count toward edge geo, assets included
    expect(geo['United Kingdom']).toBe(1);
    expect(geo['United States']).toBe(1);
  });

  it('sums served bytes', () => {
    expect(out.bytes).toBe(1667 + 11463 + 5000 + 900 + 4000 + 300 + 300);
  });
});
