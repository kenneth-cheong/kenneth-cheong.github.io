// ─────────────────────────────────────────────────────────────────────────
// SCHEDULED TOOL RUNS — the shared contract for "run tool X with these inputs,
// on this cadence". Imported by the React frontend (the Schedules page + the
// "Schedule this" button), the app API (create/validate/list), and the
// schedules cron (compute the next fire, fan out the runs).
//
// Keep it PURE — no imports, no side effects, no Node/AWS APIs — so both the
// browser bundle and every Lambda can share one source of truth.
// ─────────────────────────────────────────────────────────────────────────

/** Fixed cadence presets (v1). `perMonth` drives the estimated credit burn a
 *  schedule shows at create time. `needs` lists the extra field(s) the cadence
 *  requires (day-of-week for weekly, day-of-month for monthly). */
export const FREQUENCIES = [
  { id: 'daily', label: 'Daily', perMonth: 30, needs: [] },
  { id: 'weekly', label: 'Weekly', perMonth: 4, needs: ['dayOfWeek'] },
  { id: 'monthly', label: 'Monthly', perMonth: 1, needs: ['dayOfMonth'] },
];

export const FREQUENCY_IDS = FREQUENCIES.map((f) => f.id);

export function frequencyMeta(id) {
  return FREQUENCIES.find((f) => f.id === id) || null;
}

/** Approximate runs per calendar month for a cadence — used for the credit-cost
 *  estimate ("~150 credits / month"). Deliberately rounded, not exact. */
export function runsPerMonth(freq) {
  return frequencyMeta(freq)?.perMonth ?? 0;
}

export const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** Default timezone when the client doesn't send one (agency is SG-based). */
export const DEFAULT_TZ = 'Asia/Singapore';

// ── Timezone-aware "next fire" computation ───────────────────────────────────
// We store a schedule as { frequency, hour (0–23 local), dayOfWeek?, dayOfMonth?,
// timezone } and compute the next UTC instant it should run. All wall-clock math
// is done in the schedule's own timezone via Intl, so "9am weekly on Monday"
// fires at 9am local regardless of where the Lambda runs or DST shifts.

/** Offset (ms) of `tz` from UTC at a given instant: localWallClock - utc. */
function tzOffsetMs(utcMs, tz) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const map = {};
  for (const p of dtf.formatToParts(new Date(utcMs))) map[p.type] = p.value;
  const asUTC = Date.UTC(+map.year, +map.month - 1, +map.day, +map.hour, +map.minute, +map.second);
  return asUTC - utcMs;
}

/** The UTC instant (ms) for a wall-clock Y-M-D at `hour`:00 local in `tz`. */
function zonedToUtcMs(y, m, d, hour, tz) {
  // Guess the UTC instant treating the wall-clock as if it were UTC, then
  // correct by the tz offset AT that instant (good enough across DST; the
  // offset a few hours off doesn't change which local day/hour we land on).
  const guess = Date.UTC(y, m - 1, d, hour, 0, 0);
  return guess - tzOffsetMs(guess, tz);
}

/** Local calendar parts { y, m, d, weekday } of a UTC instant in `tz`. */
function localParts(utcMs, tz) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short',
  });
  const map = {};
  for (const p of dtf.formatToParts(new Date(utcMs))) map[p.type] = p.value;
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(map.weekday);
  return { y: +map.year, m: +map.month, d: +map.day, weekday };
}

/**
 * Next UTC instant (epoch ms) a schedule should fire, strictly after `fromMs`.
 * Iterates day-by-day (bounded) and returns the first local day + hour that
 * satisfies the cadence. Monthly clamps a too-large dayOfMonth to the month's
 * last day (so "31st" still fires in February).
 *
 *   spec: { frequency, hour, dayOfWeek, dayOfMonth, timezone }
 */
export function nextRunAt(spec, fromMs = Date.now()) {
  const tz = spec.timezone || DEFAULT_TZ;
  const hour = clampHour(spec.hour);
  const freq = spec.frequency;
  const DAY = 86400000;

  for (let i = 0; i <= 400; i++) {
    const probe = localParts(fromMs + i * DAY, tz);
    let day = probe.d;

    if (freq === 'weekly') {
      const want = ((spec.dayOfWeek ?? 1) % 7 + 7) % 7;
      if (probe.weekday !== want) continue;
    } else if (freq === 'monthly') {
      const want = clampDom(spec.dayOfMonth);
      const last = daysInMonth(probe.y, probe.m);
      const target = Math.min(want, last);
      if (probe.d !== target) continue;
      day = target;
    }
    // 'daily' matches every day.

    const fireMs = zonedToUtcMs(probe.y, probe.m, day, hour, tz);
    if (fireMs > fromMs) return fireMs;
  }
  // Fallback (should never hit): one day out.
  return fromMs + DAY;
}

function daysInMonth(y, m) {
  return new Date(Date.UTC(y, m, 0)).getUTCDate(); // m is 1-based → day 0 of next month
}

export function clampHour(h) {
  const n = Math.trunc(Number(h));
  return Number.isFinite(n) ? Math.min(23, Math.max(0, n)) : 9;
}

export function clampDom(d) {
  const n = Math.trunc(Number(d));
  return Number.isFinite(n) ? Math.min(28, Math.max(1, n)) : 1; // cap at 28 so every month has it
}

/** Human summary of a cadence, e.g. "Weekly on Monday at 09:00". */
export function describeSchedule(spec) {
  const hh = String(clampHour(spec.hour)).padStart(2, '0');
  if (spec.frequency === 'weekly') return `Weekly on ${WEEKDAYS[((spec.dayOfWeek ?? 1) % 7 + 7) % 7]} at ${hh}:00`;
  if (spec.frequency === 'monthly') return `Monthly on day ${clampDom(spec.dayOfMonth)} at ${hh}:00`;
  return `Daily at ${hh}:00`;
}

/** Validate + normalise a cadence spec from the client. Returns { ok, spec } or
 *  { ok:false, error }. Does NOT check tier limits (the caller does that). */
export function normaliseSchedule(raw = {}) {
  const frequency = String(raw.frequency || '').toLowerCase();
  if (!FREQUENCY_IDS.includes(frequency)) return { ok: false, error: 'Pick a valid frequency (daily, weekly or monthly).' };
  const spec = {
    frequency,
    hour: clampHour(raw.hour),
    timezone: typeof raw.timezone === 'string' && raw.timezone ? raw.timezone.slice(0, 64) : DEFAULT_TZ,
  };
  if (frequency === 'weekly') {
    const dow = Math.trunc(Number(raw.dayOfWeek));
    spec.dayOfWeek = Number.isFinite(dow) ? ((dow % 7) + 7) % 7 : 1; // 0=Sun … 6=Sat, default Mon
  }
  if (frequency === 'monthly') spec.dayOfMonth = clampDom(raw.dayOfMonth);
  return { ok: true, spec };
}
