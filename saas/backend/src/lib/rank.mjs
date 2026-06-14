// Rank lookups via the rankChecker upstream — shared by the tracking API
// (manual refresh / backfill) and the scheduled tracker.
//  - rankPosition: today's live rank + the ranking URL ({ position, url }).
//  - rankHistory:  past dated SERP snapshots ([{ date, position, url }]).
// Positions outside 1–100 normalise to 0 = "not ranking".
import { UPSTREAMS } from '../metering/upstreams.mjs';

async function callRankChecker(payload) {
  const res = await fetch(UPSTREAMS.rankChecker, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  let raw; try { raw = JSON.parse(text); } catch { raw = text; }
  // Some integrations wrap the result as { statusCode, body }.
  if (raw && typeof raw === 'object' && !Array.isArray(raw) && raw.statusCode !== undefined && raw.body !== undefined) {
    try { raw = typeof raw.body === 'string' ? JSON.parse(raw.body) : raw.body; } catch { raw = raw.body; }
  }
  return raw;
}

// Normalise a raw rank to 0 when the target isn't in the checked depth (the
// upstream returns a sentinel like 999). The UI shows "—"/"Unranked" and the
// chart skips 0s instead of plotting a #999 spike that wrecks the scale.
const normPos = (pos) => {
  const n = Number(pos);
  return Number.isFinite(n) && n >= 1 && n <= 100 ? n : 0;
};

export async function rankPosition({ keyword, target, location, language = 'English' }) {
  const raw = await callRankChecker({ keyword, target, language, location, withUrl: true });
  let pos, url = null;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    pos = raw.position ?? raw.rank ?? raw?.body?.position;
    url = raw.url || null;
  } else {
    pos = raw; // older Lambda: bare number
  }
  return { position: normPos(pos), url };
}

export async function rankHistory({ keyword, target, location, language = 'English' }) {
  const raw = await callRankChecker({ keyword, target, language, location, historical: true });
  const arr = Array.isArray(raw) ? raw : (Array.isArray(raw?.points) ? raw.points : []);
  return arr
    .filter((p) => p && p.date)
    .map((p) => ({ date: String(p.date).slice(0, 10), position: normPos(p.position), url: p.url || null }));
}
