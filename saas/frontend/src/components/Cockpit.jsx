import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Zap, TrendingUp, Trophy, Activity as ActivityIcon } from 'lucide-react';
import { PLANS } from '@shared/catalog.mjs';
import { useAuth } from '../context/AuthContext.jsx';
import { useProjects } from '../context/ProjectContext.jsx';
import { api } from '../lib/api.js';
import AttentionStrip from './AttentionStrip.jsx';
import { KeywordRankings, TopMovers } from './RankingCards.jsx';
import ResultCards from './ResultCards.jsx';

// The approved design's dashboard cockpit (mockup: the stat row + AI Credits
// gauge + Activity chart + Run streak).
//
// EVERY figure here is derived from real account data — run history
// (/me/runs), tracked keyword positions (/tracking) and the credit balance.
// The mockup also shows AI Citations and Share of Voice; those have no store
// behind them yet, so they are deliberately absent rather than invented.

const DAY = 86400000;
const startOfDay = (t) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };

// Consecutive days (ending today or yesterday) with at least one tool run.
// Yesterday still counts as alive — a streak shouldn't die at midnight before
// you've had a chance to run anything.
function streakFrom(days) {
  const today = startOfDay(Date.now());
  if (!days.has(today) && !days.has(today - DAY)) return 0;
  let n = 0;
  for (let d = days.has(today) ? today : today - DAY; days.has(d); d -= DAY) n++;
  return n;
}

export default function Cockpit({ googleConnected }) {
  const { user } = useAuth();
  const { activeId } = useProjects();
  const [runs, setRuns] = useState(null);
  const [tracked, setTracked] = useState(null);

  useEffect(() => { api.runs().then((d) => setRuns(d.runs || [])).catch(() => setRuns([])); }, []);
  useEffect(() => { api.tracking(activeId).then((d) => setTracked(d.tracked || [])).catch(() => setTracked([])); }, [activeId]);

  const max = PLANS[user.tier].monthlyCredits;
  const left = user.credits || 0;
  const used = Math.max(0, max - Math.max(0, left - (user.topupCredits || 0)));

  // ── Activity: runs per day over the last 7 days ────────────────────────────
  const activity = useMemo(() => {
    const today = startOfDay(Date.now());
    const buckets = Array.from({ length: 7 }, (_, i) => ({ day: today - (6 - i) * DAY, n: 0 }));
    (runs || []).forEach((r) => {
      const d = startOfDay(new Date(r.ts).getTime());
      const b = buckets.find((x) => x.day === d);
      if (b) b.n++;
    });
    return buckets;
  }, [runs]);

  const streak = useMemo(
    () => streakFrom(new Set((runs || []).map((r) => startOfDay(new Date(r.ts).getTime())))),
    [runs]
  );
  const runsThisWeek = activity.reduce((n, b) => n + b.n, 0);

  // ── Rankings: average position + keywords on page 1 ────────────────────────
  const rank = useMemo(() => {
    const latest = (tracked || [])
      .map((t) => t.history?.[t.history.length - 1]?.position)
      .filter((p) => typeof p === 'number' && p >= 1);
    if (!latest.length) return null;
    return {
      avg: latest.reduce((a, b) => a + b, 0) / latest.length,
      page1: latest.filter((p) => p <= 10).length,
      total: tracked.length,
    };
  }, [tracked]);

  const peak = Math.max(1, ...activity.map((b) => b.n));
  // Area + line path across the 7 buckets (mockup's .mini chart).
  const pts = activity.map((b, i) => [20 + i * 143, 150 - (b.n / peak) * 120]);
  const line = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(0)},${y.toFixed(0)}`).join(' ');
  const area = `${line} L${pts[6][0]},150 L${pts[0][0]},150 Z`;

  return (
    <>
      <AttentionStrip
        tracked={tracked}
        googleConnected={googleConnected}
        onUpgrade={() => window.dispatchEvent(new CustomEvent('dm:open-plan'))}
      />
      <div className="dm-cockpit-grid mt-4">
      {/* ── Stat row ───────────────────────────────────────────────────────── */}
      <div className="dm-stat-row" style={{ gridColumn: "1 / -1" }}>
        <Stat
          label="Avg. position"
          icon={<TrendingUp size={15} aria-hidden />}
          value={rank ? rank.avg.toFixed(1) : '—'}
          sub={rank ? `${rank.total} tracked keyword${rank.total === 1 ? '' : 's'}` : 'No keywords tracked yet'}
          to="/tracking"
        />
        <Stat
          label="Keywords on page 1"
          icon={<Trophy size={15} aria-hidden />}
          value={rank ? String(rank.page1) : '—'}
          sub={rank ? `of ${rank.total} tracked` : 'Track keywords to see this'}
          to="/tracking"
        />
        <Stat
          label="Tool runs"
          icon={<ActivityIcon size={15} aria-hidden />}
          value={runs === null ? '—' : String(runsThisWeek)}
          sub={streak > 0 ? `${streak}-day streak · last 7 days` : 'Last 7 days'}
          to="/history"
        />
      </div>

      {/* ── Activity chart ─────────────────────────────────────────────────── */}
      <Link to="/history" className="card card-hover block p-[18px]">
        <div className="flex items-center justify-between">
          <span className="text-[10px] font-bold uppercase tracking-[0.18em] text-faint">Activity</span>
          <span className="text-[11px] font-semibold text-muted">Tool runs · last 7 days</span>
        </div>
        {runsThisWeek === 0 ? (
          <p className="py-10 text-center text-xs text-faint">
            {runs === null ? 'Loading…' : 'No runs in the last 7 days — your activity will chart here.'}
          </p>
        ) : (
          <>
            <svg viewBox="0 0 900 170" className="mt-3 block w-full overflow-visible" role="img" aria-label={`${runsThisWeek} tool runs over the last 7 days`}>
              <g stroke="rgb(var(--c-line))" strokeWidth="1">
                {[30, 70, 110, 150].map((y) => <line key={y} x1="20" y1={y} x2="880" y2={y} />)}
              </g>
              <defs>
                <linearGradient id="dm-act" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="rgb(var(--c-pos))" stopOpacity=".35" />
                  <stop offset="100%" stopColor="rgb(var(--c-pos))" stopOpacity="0" />
                </linearGradient>
              </defs>
              <path d={area} fill="url(#dm-act)" />
              <path d={line} fill="none" stroke="rgb(var(--c-pos))" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
              {pts.map(([x, y], i) => <circle key={i} cx={x} cy={y} r="4" fill="rgb(var(--c-pos))" />)}
            </svg>
            <div className="mt-1 flex justify-between text-[10px] font-semibold text-faint">
              {activity.map((b) => (
                <span key={b.day}>{new Date(b.day).toLocaleDateString(undefined, { weekday: 'short' }).toUpperCase()}</span>
              ))}
            </div>
          </>
        )}
      </Link>

      {/* ── Tracking & Results: the two cards real data backs ─────────────── */}
      <KeywordRankings tracked={tracked} />
      <TopMovers tracked={tracked} />

      {/* ── Credits gauge ──────────────────────────────────────────────────── */}
      <Link to="/usage" className="card card-hover flex flex-col p-[18px]">
        <span className="text-[10px] font-bold uppercase tracking-[0.18em] text-faint">AI Credits</span>
        <div className="grid flex-1 place-items-center py-3">
          <Gauge used={used} max={max} />
        </div>
        <div className="flex items-center gap-2.5 rounded-xl border border-line bg-raised p-3">
          <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg" style={{ background: 'rgb(var(--c-warn) / .18)' }}>
            <Zap size={14} className="text-warn" aria-hidden />
          </span>
          <span className="text-[11.5px] font-semibold text-body">
            You have {left.toLocaleString()} credit{left === 1 ? '' : 's'} left
          </span>
        </div>
      </Link>
      </div>

      {/* Tracking & Results — each card reads its tool's latest stored run. */}
      <ResultCards />
    </>
  );
}

function Stat({ label, icon, value, sub, to }) {
  return (
    <Link to={to} className="card card-hover group flex flex-col gap-2.5 p-[18px]">
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-bold uppercase tracking-[0.18em] text-faint">{label}</span>
        <span className="dm-kick grid h-8 w-8 place-items-center rounded-[10px] text-peri" style={{ background: 'rgb(var(--c-peri) / .16)' }}>
          {icon}
        </span>
      </div>
      <div className="text-3xl font-extrabold leading-none tracking-tight tabular-nums text-heading">{value}</div>
      <div className="text-[11px] font-medium text-muted">{sub}</div>
    </Link>
  );
}

// The mockup's ring gauge. An SVG arc rather than a conic-gradient so the track
// and the progress stroke round off identically at both ends.
function Gauge({ used, max }) {
  const r = 52;
  const circ = 2 * Math.PI * r;
  const gap = 0.28;                                   // fraction left open at the bottom
  const span = circ * (1 - gap);
  const pct = Math.max(0, Math.min(1, max ? used / max : 0));

  return (
    <div className="relative grid place-items-center">
      <svg width="132" height="132" viewBox="0 0 132 132" role="img" aria-label={`${used} of ${max} credits used`}>
        <g transform="rotate(126 66 66)">
          <circle cx="66" cy="66" r={r} fill="none" stroke="rgb(var(--c-canvas))" strokeWidth="10"
            strokeLinecap="round" strokeDasharray={`${span} ${circ}`} />
          <circle cx="66" cy="66" r={r} fill="none" stroke="rgb(var(--c-pos))" strokeWidth="10"
            strokeLinecap="round" strokeDasharray={`${span * pct} ${circ}`} />
        </g>
      </svg>
      <div className="absolute grid place-items-center">
        <div className="text-3xl font-extrabold tracking-tight tabular-nums text-heading">{used.toLocaleString()}</div>
        <div className="text-[10px] font-semibold text-muted">of {max.toLocaleString()} used</div>
      </div>
    </div>
  );
}
