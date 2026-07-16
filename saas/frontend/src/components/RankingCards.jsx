import { useMemo } from 'react';
import { Link } from 'react-router-dom';

// Two of the approved design's Tracking & Results cards — the two whose numbers
// the app can actually stand behind, both derived from tracked keyword history
// (/tracking): the ranking distribution, and this week's biggest movers.
//
// The rest of that wall needs data the tools don't produce yet — see the
// dashboard notes. Nothing here is invented; a keyword with too little history
// simply doesn't appear as a mover.

// The mockup's five ranking bands.
const BANDS = [
  { key: 'Top 3', test: (p) => p <= 3, hue: 'var(--c-pos)' },
  { key: '4–10', test: (p) => p <= 10, hue: 'var(--c-peri)' },
  { key: '11–20', test: (p) => p <= 20, hue: 'var(--c-cta)' },
  { key: '21–50', test: (p) => p <= 50, hue: 'var(--c-warn)' },
  { key: '51+', test: () => true, hue: 'var(--c-faint)' },
];

const latest = (t) => t.history?.[t.history.length - 1]?.position;

export function KeywordRankings({ tracked }) {
  const bands = useMemo(() => {
    const counts = BANDS.map((b) => ({ ...b, n: 0 }));
    (tracked || []).forEach((t) => {
      const p = latest(t);
      if (typeof p !== 'number' || p < 1) return;
      counts.find((b) => b.test(p)).n++;
    });
    return counts;
  }, [tracked]);

  const ranked = bands.reduce((n, b) => n + b.n, 0);
  const total = (tracked || []).length;

  return (
    <section className="card p-[18px]">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10px] font-bold uppercase tracking-[0.18em] text-faint">Keyword rankings</span>
        {ranked > 0 && (
          <span className="rounded-full px-2.5 py-1 text-[10.5px] font-extrabold text-pos" style={{ background: 'rgb(var(--c-pos) / .14)' }}>
            {bands[0].n + bands[1].n} on page 1
          </span>
        )}
      </div>

      <div className="mt-3 flex items-baseline gap-2">
        <span className="text-4xl font-extrabold leading-none tracking-tight tabular-nums text-heading">{total}</span>
        <span className="text-xs font-semibold text-muted">keyword{total === 1 ? '' : 's'} tracked</span>
      </div>

      {ranked === 0 ? (
        <p className="mt-4 text-xs text-faint">
          {total === 0 ? 'No keywords tracked yet.' : 'No positions recorded yet — the next check will fill this in.'}
        </p>
      ) : (
        <>
          {/* Proportional band bar — each segment sized to its share. */}
          <div className="mt-3.5 flex gap-1 overflow-hidden">
            {bands.filter((b) => b.n > 0).map((b) => (
              <span key={b.key} className="h-2.5 rounded" style={{ flex: b.n, background: `rgb(${b.hue})` }} title={`${b.key}: ${b.n}`} />
            ))}
          </div>
          <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5">
            {bands.map((b) => (
              <span key={b.key} className="flex items-center gap-2 text-[11px]">
                <i className="h-2 w-2 shrink-0 rounded-full" style={{ background: `rgb(${b.hue})` }} />
                <span className="flex-1 font-medium text-muted">{b.key}</span>
                <b className="tabular-nums text-heading">{b.n}</b>
              </span>
            ))}
          </div>
        </>
      )}
    </section>
  );
}

export function TopMovers({ tracked }) {
  const movers = useMemo(() => {
    return (tracked || [])
      .map((t) => {
        const h = (t.history || []).filter((x) => typeof x.position === 'number' && x.position >= 1);
        if (h.length < 2) return null;
        // Lower position = better, so an improvement is (before - now).
        const delta = h[0].position - h[h.length - 1].position;
        if (delta === 0) return null;
        return { keyword: t.keyword, delta, series: h.slice(-8).map((x) => x.position) };
      })
      .filter(Boolean)
      .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
      .slice(0, 5);
  }, [tracked]);

  return (
    <section className="card p-[18px]">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10px] font-bold uppercase tracking-[0.18em] text-faint">Top movers</span>
        <span className="rounded-full bg-sunken px-2.5 py-1 text-[10.5px] font-bold text-muted">all time</span>
      </div>

      {movers.length === 0 ? (
        <p className="mt-4 text-xs text-faint">
          Not enough position history yet — movers appear once a keyword has been checked twice.
        </p>
      ) : (
        <ul className="mt-2 flex flex-col">
          {movers.map((m) => (
            <li key={m.keyword} className="flex items-center gap-3 border-b border-hair py-2.5 last:border-0">
              <span className="min-w-0 flex-1 truncate text-xs font-medium text-body" title={m.keyword}>{m.keyword}</span>
              <Spark series={m.series} up={m.delta > 0} />
              <span className={`shrink-0 text-xs font-bold tabular-nums ${m.delta > 0 ? 'text-pos' : 'text-neg'}`}>
                {m.delta > 0 ? '▲' : '▼'} {Math.abs(m.delta)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// Sparkline of a keyword's positions. Y is inverted — rank 1 is the TOP of the
// chart — so a line going up always means "getting better".
function Spark({ series, up }) {
  const min = Math.min(...series);
  const max = Math.max(...series);
  const span = Math.max(1, max - min);
  const pts = series.map((p, i) => {
    const x = (i / Math.max(1, series.length - 1)) * 58;
    const y = 2 + ((p - min) / span) * 16;
    return `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  return (
    <svg width="58" height="20" viewBox="0 0 58 20" className="shrink-0" aria-hidden>
      <path d={pts} fill="none" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
        stroke={up ? 'rgb(var(--c-pos))' : 'rgb(var(--c-neg))'} />
    </svg>
  );
}
