// Single live rank lookup via the rankChecker upstream — shared by the tracking
// API (manual refresh) and the scheduled tracker. Returns 0 when not in top 100.
import { UPSTREAMS } from '../metering/upstreams.mjs';

export async function rankPosition({ keyword, target, location, language = 'English' }) {
  const res = await fetch(UPSTREAMS.rankChecker, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ keyword, target, language, location }),
  });
  const text = await res.text();
  let raw; try { raw = JSON.parse(text); } catch { raw = text; }
  if (raw && typeof raw === 'object' && raw.statusCode !== undefined && raw.body !== undefined) {
    raw = typeof raw.body === 'string' ? JSON.parse(raw.body) : raw.body;
  }
  const pos = typeof raw === 'number' ? raw : (raw?.position ?? raw?.rank ?? (typeof raw === 'object' ? raw?.body?.position : null));
  const n = Number(pos);
  // The upstream returns a sentinel (e.g. 999) when the target isn't found in
  // the checked SERP depth. Normalise anything outside 1–100 to 0 = "not
  // ranking" so the UI shows "—" and the chart skips the point (LineChart filters
  // v > 0) instead of plotting a #999 spike that wrecks the scale.
  return Number.isFinite(n) && n >= 1 && n <= 100 ? n : 0;
}
