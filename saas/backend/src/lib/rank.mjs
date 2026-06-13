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
  return Number(pos) || 0;
}
