// Scheduled job (EventBridge, daily): refresh every tracked keyword's rank and
// append a position snapshot, so the tracking charts build history over time.
//
// It also fires a change-alert notification when a keyword crosses a threshold
// worth hearing about — broke into the top 3 / page 1 (celebrate), slipped off
// page 1, or moved 10+ spots. The bell polls these, so ranking movement reaches
// the user without them re-opening the tracking page.
import { scanTracked, appendSnapshot, addNotification, getUser } from '../lib/dynamo.mjs';
import { rankPosition } from '../lib/rank.mjs';
import { accessLocked } from '../lib/access.mjs';

// Positions are 1..100, or 0 for "unranked" (see lib/rank normPos).
const onPage1 = (p) => p >= 1 && p <= 10;
const ranked = (p) => p >= 1 && p <= 100;

// Decide whether a move from `prev` → `curr` is worth a notification, and phrase
// it. Returns { title, body } or null. At most one alert per keyword per run.
function rankAlert(keyword, domain, prev, curr) {
  const kw = `“${keyword}”`;
  const at = ranked(curr) ? `now #${curr}` : 'now unranked';
  const site = domain ? ` for ${domain}` : '';
  if (curr >= 1 && curr <= 3 && !(prev >= 1 && prev <= 3))       // broke into top 3
    return { title: `${kw} broke into the top 3`, body: `Ranking ${at}${site} — nice work.` };
  if (onPage1(curr) && !onPage1(prev))                            // reached page 1
    return { title: `${kw} hit page 1`, body: `Ranking ${at}${site}. Keep the momentum going.` };
  if (onPage1(prev) && !onPage1(curr))                            // slipped off page 1
    return { title: `${kw} slipped off page 1`, body: `Was #${prev}, ${at}${site}. Worth a look.` };
  if (ranked(prev) && ranked(curr) && curr - prev >= 10)          // big drop
    return { title: `${kw} dropped ${curr - prev} spots`, body: `Down from #${prev} to #${curr}${site}.` };
  if (ranked(prev) && ranked(curr) && prev - curr >= 10)          // big climb
    return { title: `${kw} climbed ${prev - curr} spots`, body: `Up from #${prev} to #${curr}${site}.` };
  return null;
}

export const handler = async () => {
  const all = await scanTracked();
  let updated = 0, alerts = 0, held = 0;
  // Owner lookups, memoised per run: one user typically owns many keywords, and
  // this loop can be thousands of rows long.
  const owners = new Map();
  const owner = async (userId) => {
    if (!owners.has(userId)) owners.set(userId, await getUser(userId).catch(() => null));
    return owners.get(userId);
  };
  for (const t of all) {
    try {
      // Expired trial / unpaid subscription → hold the keyword, don't drop it.
      // Each check is a paid upstream SERP call, so refreshing rankings for an
      // account that can't view them spends real money on nothing. The keyword
      // and its whole history stay put; the daily updates simply resume on the
      // first tick after payment (with a gap in the chart for the unpaid days).
      if (accessLocked(await owner(t.userId))) { held++; continue; }
      // Baseline BEFORE this run's append. `lastPosition` is set by the previous
      // appendSnapshot; it's undefined only on a keyword never checked before —
      // skip alerting on that first snapshot (no baseline to compare against).
      const prev = typeof t.lastPosition === 'number' ? t.lastPosition
        : (t.history?.length ? t.history[t.history.length - 1].position : null);
      const { position, url } = await rankPosition({ keyword: t.keyword, target: t.domain, location: t.location });
      await appendSnapshot(t.userId, t.trackId, position, url);
      updated++;

      if (prev !== null) {
        const alert = rankAlert(t.keyword, t.domain, prev, position);
        if (alert) {
          await addNotification({ userId: t.userId, title: alert.title, body: alert.body, link: '/tracking', kind: 'alert' });
          alerts++;
        }
      }
    } catch (e) { console.error('track_failed', t.trackId, e.message); }
  }
  console.log(JSON.stringify({ metric: 'tracking_run', tracked: all.length, updated, alerts, held }));
  return { updated, alerts, held };
};
