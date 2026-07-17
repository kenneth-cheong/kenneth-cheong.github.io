import { Link } from 'react-router-dom';
import { ArrowRight, Zap } from 'lucide-react';
import { toolById } from '@shared/catalog.mjs';
import { ago } from '../lib/latestRuns.js';

// Detail bodies + footer link for the dashboard card modals. Every figure here
// is derived from the same real data the cards already read (tracked keyword
// history, run history, the credit balance) — nothing invented. Each modal is a
// read-only "look closer", with a footer link out to the tool that produced it.

const latestPos = (t) => t.history?.[t.history.length - 1]?.position;
const deltaOf = (t) => {
  const h = (t.history || []).filter((x) => typeof x.position === 'number' && x.position >= 1);
  if (h.length < 2) return null;
  return h[0].position - h[h.length - 1].position; // + = moved up (better)
};

// Footer call-to-action — the "go run / open full view" link. `primary` is the
// filled brand button; the rest are quiet outlines.
export function DetailLink({ to, children, primary = false, onClick }) {
  return (
    <Link
      to={to}
      onClick={onClick}
      className={
        primary
          ? 'inline-flex items-center gap-1.5 rounded-xl bg-brand-600 px-4 py-2.5 text-sm font-bold text-white hover:bg-brand-700'
          : 'inline-flex items-center gap-1.5 rounded-xl border border-line px-4 py-2.5 text-sm font-semibold text-dim hover:bg-raised'
      }
    >
      {children} <ArrowRight size={15} aria-hidden />
    </Link>
  );
}

// Inverted sparkline (rank 1 = top), so a rising line always means "improving".
function Spark({ series, up }) {
  if (!series || series.length < 2) return null;
  const min = Math.min(...series);
  const max = Math.max(...series);
  const span = Math.max(1, max - min);
  const d = series
    .map((p, i) => {
      const x = (i / (series.length - 1)) * 58;
      const y = 2 + ((p - min) / span) * 16;
      return `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
  return (
    <svg width="58" height="20" viewBox="0 0 58 20" className="shrink-0" aria-hidden>
      <path d={d} fill="none" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
        stroke={up ? 'rgb(var(--c-pos))' : 'rgb(var(--c-neg))'} />
    </svg>
  );
}

// Keyword table detail. `mode` tunes the header line + which rows show / how they
// sort: 'avg' (all, by position), 'page1' (only top-10), 'movers' (by |Δ|).
export function KeywordDetail({ tracked, mode = 'avg' }) {
  const rows = (tracked || [])
    .map((t) => ({
      keyword: t.keyword,
      pos: latestPos(t),
      delta: deltaOf(t),
      series: (t.history || [])
        .filter((x) => typeof x.position === 'number' && x.position >= 1)
        .slice(-8)
        .map((x) => x.position),
    }))
    .filter((r) => typeof r.pos === 'number' && r.pos >= 1);

  let list = mode === 'page1' ? rows.filter((r) => r.pos <= 10) : rows;
  list = mode === 'movers'
    ? list.filter((r) => r.delta).sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
    : [...list].sort((a, b) => a.pos - b.pos);

  const total = rows.length;
  const page1 = rows.filter((r) => r.pos <= 10).length;
  const avg = total ? rows.reduce((a, r) => a + r.pos, 0) / total : 0;
  const summary =
    mode === 'page1' ? `${page1} of ${total} tracked keyword${total === 1 ? '' : 's'} on page 1`
    : mode === 'movers' ? `Biggest position changes across ${total} tracked keyword${total === 1 ? '' : 's'}`
    : `Average position ${avg.toFixed(1)} across ${total} tracked keyword${total === 1 ? '' : 's'}`;

  if (!list.length) {
    return <p className="py-10 text-center text-sm text-faint">No keyword positions recorded yet — track keywords and the next check fills this in.</p>;
  }

  return (
    <div>
      <p className="mb-3 text-sm text-muted">{summary}</p>
      <div className="overflow-hidden rounded-xl border border-line">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line bg-raised text-[11px] uppercase tracking-wide text-faint">
              <th className="px-3 py-2 text-left font-bold">Keyword</th>
              <th className="px-3 py-2 text-right font-bold">Position</th>
              <th className="px-3 py-2 text-right font-bold">Change</th>
              <th className="px-3 py-2 text-right font-bold">Trend</th>
            </tr>
          </thead>
          <tbody>
            {list.map((r) => (
              <tr key={r.keyword} className="border-b border-hair last:border-0">
                <td className="max-w-[220px] truncate px-3 py-2 font-medium text-body" title={r.keyword}>{r.keyword}</td>
                <td className="px-3 py-2 text-right tabular-nums text-strong">
                  {r.pos}{r.pos <= 10 && <span className="ml-1.5 rounded bg-pos/15 px-1.5 py-0.5 text-[10px] font-bold text-pos">P1</span>}
                </td>
                <td className={`px-3 py-2 text-right tabular-nums font-semibold ${r.delta > 0 ? 'text-pos' : r.delta < 0 ? 'text-neg' : 'text-faint'}`}>
                  {r.delta == null ? '—' : r.delta === 0 ? '0' : `${r.delta > 0 ? '▲' : '▼'} ${Math.abs(r.delta)}`}
                </td>
                <td className="px-3 py-2"><div className="flex justify-end"><Spark series={r.series} up={(r.delta || 0) >= 0} /></div></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// Recent run history — the rows behind the Tool-runs / Activity cards.
export function RunsDetail({ runs }) {
  const list = [...(runs || [])].sort((a, b) => b.ts - a.ts).slice(0, 30);
  if (!list.length) {
    return <p className="py-10 text-center text-sm text-faint">No tool runs yet — run a tool and it shows up here.</p>;
  }
  return (
    <div>
      <p className="mb-3 text-sm text-muted">Your {list.length} most recent tool run{list.length === 1 ? '' : 's'}.</p>
      <ul className="overflow-hidden rounded-xl border border-line">
        {list.map((r, i) => (
          <li key={i} className="flex items-center gap-3 border-b border-hair px-3 py-2.5 last:border-0">
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium text-body">{toolById(r.tool)?.name || r.toolName || r.tool}</span>
              {r.target && <span className="block truncate text-xs text-faint" title={r.target}>{r.target}</span>}
            </span>
            <span className="shrink-0 whitespace-nowrap text-xs text-muted">{ago(r.ts)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// Credit allowance breakdown behind the AI-Credits gauge.
export function CreditsDetail({ used, max, left, topup = 0 }) {
  const rows = [
    ['Monthly allowance', max, 'text-body'],
    ['Used this cycle', used, 'text-body'],
    topup ? ['Top-up credits', topup, 'text-body'] : null,
    ['Remaining', left, 'text-strong font-bold'],
  ].filter(Boolean);
  const pct = max ? Math.min(100, Math.round((used / max) * 100)) : 0;
  return (
    <div>
      <div className="mb-4 flex items-center gap-3 rounded-xl border border-line bg-raised p-3.5">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg" style={{ background: 'rgb(var(--c-warn) / .18)' }}>
          <Zap size={16} className="text-warn" aria-hidden />
        </span>
        <span className="text-sm font-semibold text-body">{left.toLocaleString()} credit{left === 1 ? '' : 's'} left this cycle</span>
      </div>
      <div className="mb-4 h-2 overflow-hidden rounded-full bg-sunken">
        <div className="h-full rounded-full bg-brand-600" style={{ width: `${pct}%` }} />
      </div>
      <dl className="overflow-hidden rounded-xl border border-line">
        {rows.map(([label, val, cls]) => (
          <div key={label} className="flex items-center justify-between border-b border-hair px-3.5 py-2.5 text-sm last:border-0">
            <dt className="text-muted">{label}</dt>
            <dd className={`tabular-nums ${cls}`}>{Number(val).toLocaleString()}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
