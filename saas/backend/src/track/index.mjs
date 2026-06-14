// Scheduled job (EventBridge, daily): refresh every tracked keyword's rank and
// append a position snapshot, so the tracking charts build history over time.
import { scanTracked, appendSnapshot } from '../lib/dynamo.mjs';
import { rankPosition } from '../lib/rank.mjs';

export const handler = async () => {
  const all = await scanTracked();
  let updated = 0;
  for (const t of all) {
    try {
      const { position, url } = await rankPosition({ keyword: t.keyword, target: t.domain, location: t.location });
      await appendSnapshot(t.userId, t.trackId, position, url);
      updated++;
    } catch (e) { console.error('track_failed', t.trackId, e.message); }
  }
  console.log(JSON.stringify({ metric: 'tracking_run', tracked: all.length, updated }));
  return { updated };
};
