import LineChart from './LineChart.jsx';
import TrendChart from './TrendChart.jsx';
import SortableTable from './SortableTable.jsx';
import { copyText, toast } from '../lib/ui.js';
import InfoTip, { glossaryFor } from './InfoTip.jsx';
import RecommendationCard from './RecommendationCard.jsx';
import { Check, X, Info, TrendingUp, TrendingDown } from 'lucide-react';

// Themed renderer for the structured `sections` result format. Turns the raw
// section data (stats / lists / tables / cards / code …) into a polished,
// scannable report: score gauges, keyword chips, pass/fail rows, accented
// section titles. Print-friendly and consistent with the app's blue theme.

// tone → colour treatments. `bg`/`border` tint stat & callout surfaces; `text`
// colours headline numbers; `stroke` paints the gauge arc.
const TONES = {
  green:  { bg: 'bg-emerald-50/70', border: 'border-emerald-100', text: 'text-emerald-700', chip: 'bg-emerald-100 text-emerald-700', stroke: '#059669' },
  amber:  { bg: 'bg-amber-50/70',   border: 'border-amber-100',   text: 'text-amber-700',   chip: 'bg-amber-100 text-amber-700',   stroke: '#d97706' },
  red:    { bg: 'bg-red-50/70',     border: 'border-red-100',     text: 'text-red-700',     chip: 'bg-red-100 text-red-700',       stroke: '#dc2626' },
  blue:   { bg: 'bg-brand-50/70',   border: 'border-brand-100',   text: 'text-brand-700',   chip: 'bg-brand-100 text-brand-700',   stroke: '#2563eb' },
  orange: { bg: 'bg-orange-50/70',  border: 'border-orange-100',  text: 'text-orange-700',  chip: 'bg-orange-100 text-orange-700', stroke: '#ea580c' },
  slate:  { bg: 'bg-slate-50',      border: 'border-slate-200',   text: 'text-slate-900',   chip: 'bg-slate-100 text-slate-600',   stroke: '#64748b' },
};
const tone = (t) => TONES[t] || TONES.slate;

export default function ResultSections({ sections, context }) {
  return <div className="space-y-6">{sections.map((s, i) => <Section key={i} s={s} context={context} />)}</div>;
}

// Accented sub-section title — a small brand bar gives the report visual rhythm.
function Title({ children }) {
  if (!children) return null;
  return (
    <h4 className="mb-3 flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-slate-700">
      <span className="h-3.5 w-1 rounded-full bg-brand-500" aria-hidden /> {children}
    </h4>
  );
}
function Block({ title, children }) { return <div>{title && <Title>{title}</Title>}{children}</div>; }

function Section({ s, context }) {
  switch (s.type) {
    case 'heading':
      return <h3 className="border-b border-slate-100 pb-2 text-xl font-bold tracking-tight text-slate-900">{s.text}</h3>;
    case 'callout':
      return (
        <div className="flex items-start gap-2.5 rounded-xl border border-brand-100 bg-brand-50/60 px-4 py-3 text-sm text-slate-700">
          <Info size={16} className="mt-0.5 shrink-0 text-brand-500" aria-hidden />
          <span>{s.text}</span>
        </div>
      );
    case 'text':
      return <p className="text-sm leading-relaxed text-slate-500">{s.text}</p>;
    case 'stats':
      return (
        <Block title={s.title}>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {s.items.map((it, i) => <StatCard key={i} it={it} />)}
          </div>
        </Block>
      );
    case 'list':
      return <ListSection s={s} />;
    case 'chart':
      return <Block title={s.title}>{Array.isArray(s.series) ? <TrendChart series={s.series} /> : <LineChart data={s.data} />}</Block>;
    case 'cards':
      // Cards that carry a `body` are real recommendations/insights → give them
      // the actionable card (How / Do it for me / Add to plan). Cards without a
      // body (ranked "opportunity" cards: lines + barPct + meta) stay plain.
      return (
        <Block title={s.title}>
          {s.note && <p className="-mt-1 mb-3 text-sm text-slate-500">{s.note}</p>}
          <div className="space-y-2.5">
            {s.items.map((c, i) => (c && c.body
              ? <RecommendationCard key={i} card={c} sectionTitle={s.title} context={context} />
              : <Card key={i} c={c} />))}
          </div>
        </Block>
      );
    case 'table':
      return <TableSection s={s} />;
    case 'code':
      return <CodeBlock title={s.title} filename={s.filename} content={s.content} />;
    default:
      return null;
  }
}

// ── Stats → metric cards (gauge for %, big number otherwise) ─────────────────
function pctOf(v) {
  const s = String(v ?? '');
  if (!s.includes('%')) return null;
  const n = parseFloat(s);
  return Number.isFinite(n) && n >= 0 && n <= 100 ? Math.round(n) : null;
}

function Gauge({ pct, stroke }) {
  const r = 24, C = 2 * Math.PI * r;
  const off = C * (1 - Math.max(0, Math.min(100, pct)) / 100);
  return (
    <svg width="60" height="60" viewBox="0 0 60 60" className="block" role="img" aria-label={`${pct}%`}>
      <circle cx="30" cy="30" r={r} fill="none" stroke="#e2e8f0" strokeWidth="6" />
      <circle cx="30" cy="30" r={r} fill="none" stroke={stroke} strokeWidth="6" strokeLinecap="round"
        strokeDasharray={C} strokeDashoffset={off} transform="rotate(-90 30 30)" />
      <text x="30" y="34" textAnchor="middle" fill="#0f172a" style={{ fontSize: 14, fontWeight: 700 }}>{pct}%</text>
    </svg>
  );
}

function StatCard({ it }) {
  const t = tone(it.tone);
  const pct = pctOf(it.value);
  const def = glossaryFor(it.label);
  return (
    <div className={`rounded-xl border ${t.border} ${t.bg} p-3.5`}>
      <div className="flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
        <span>{it.label}</span>
        {def && <InfoTip text={def} size={12} />}
      </div>
      {pct != null
        ? <div className="mt-1.5"><Gauge pct={pct} stroke={t.stroke} /></div>
        : <div className={`mt-1 text-2xl font-bold leading-tight ${t.text}`}>{it.value}</div>}
      {it.delta && (
        <div className={`mt-1.5 inline-flex items-center gap-1 text-xs font-semibold ${it.deltaTone === 'red' ? 'text-red-600' : it.deltaTone === 'green' ? 'text-emerald-600' : 'text-slate-400'}`}>
          {it.deltaTone === 'green' ? <TrendingUp size={13} aria-hidden /> : it.deltaTone === 'red' ? <TrendingDown size={13} aria-hidden /> : null}
          {it.delta}<span className="ml-0.5 font-normal text-slate-400">vs prev</span>
        </div>
      )}
    </div>
  );
}

// ── Lists → chips, pass/fail rows (✓/✗), value-bar breakdowns, or a list ─────
const STATUS_RE = /^\s*([✓✗])\s*/;
// "label: 1,234" / "label: 12.5" → a labelled numeric distribution row.
const KV_RE = /^\s*(.+?):\s*([\d][\d,]*(?:\.\d+)?)\s*$/;
const stripBullet = (s) => String(s).replace(/^\s*[•\-–]\s*/, '');

function ListSection({ s }) {
  const items = (s.items || []).map((x) => (x == null ? '' : String(x))).filter(Boolean);
  if (!items.length) return null;
  const allStatus = items.every((x) => STATUS_RE.test(x));
  const kv = items.map((x) => {
    const m = x.match(KV_RE);
    return m ? { label: m[1].trim(), raw: m[2], value: parseFloat(m[2].replace(/,/g, '')) } : null;
  });
  const allKV = !allStatus && items.length >= 2 && kv.every((k) => k && Number.isFinite(k.value));
  const allChips = !allStatus && !allKV && items.every((x) => x.length <= 44 && !x.includes(':') && !STATUS_RE.test(x));

  // Numeric distribution (link types, TLDs, countries…) → proportional bars.
  if (allKV) {
    const max = Math.max(...kv.map((k) => k.value), 1);
    return (
      <Block title={s.title}>
        <div className="space-y-1.5">
          {kv.map((k, i) => (
            <div key={i} className="flex items-center gap-3 text-sm">
              <span className="w-36 shrink-0 truncate text-slate-600" title={k.label}>{k.label}</span>
              <div className="h-2 flex-1 overflow-hidden rounded-full bg-slate-100">
                <div className="h-full rounded-full bg-gradient-to-r from-brand-400 to-brand-600" style={{ width: `${Math.max(2, (k.value / max) * 100)}%` }} />
              </div>
              <span className="w-16 shrink-0 text-right font-semibold tabular-nums text-slate-700">{k.raw}</span>
            </div>
          ))}
        </div>
      </Block>
    );
  }

  if (allStatus) {
    return (
      <Block title={s.title}>
        <div className="space-y-1.5">
          {items.map((x, i) => {
            const ok = x.trim().startsWith('✓');
            return (
              <div key={i} className="flex items-start gap-2.5 text-sm text-slate-700">
                <span className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full ${ok ? 'bg-emerald-100 text-emerald-600' : 'bg-red-100 text-red-600'}`}>
                  {ok ? <Check size={13} strokeWidth={3} aria-hidden /> : <X size={13} strokeWidth={3} aria-hidden />}
                </span>
                <span>{x.replace(STATUS_RE, '')}</span>
              </div>
            );
          })}
        </div>
      </Block>
    );
  }

  if (allChips) {
    return (
      <Block title={s.title}>
        <div className="flex flex-wrap gap-2">
          {items.map((x, i) => <span key={i} className="inline-flex items-center rounded-full bg-slate-100 px-3 py-1 text-[13px] font-medium text-slate-700">{x}</span>)}
        </div>
      </Block>
    );
  }

  const textColor = s.tone === 'green' ? 'text-emerald-700' : s.tone === 'red' ? 'text-red-700' : 'text-slate-600';
  return (
    <Block title={s.title}>
      <ul className="space-y-1.5 text-sm">
        {items.map((x, i) => (
          <li key={i} className="flex gap-2.5">
            <span className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-brand-400" aria-hidden />
            <span className={textColor}>{stripBullet(x)}</span>
          </li>
        ))}
      </ul>
    </Block>
  );
}

// ── Cards (e.g. ranked opportunities with a progress bar) ────────────────────
const BADGE = {
  red: 'bg-red-100 text-red-700', amber: 'bg-amber-100 text-amber-700', green: 'bg-emerald-100 text-emerald-700',
  blue: 'bg-brand-100 text-brand-700', orange: 'bg-orange-100 text-orange-700', slate: 'bg-slate-100 text-slate-600',
};
function Card({ c }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-3.5 transition-shadow hover:shadow-sm">
      <div className="flex flex-wrap items-center gap-2">
        <strong className="text-slate-800">{c.title}</strong>
        {c.badge && <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${BADGE[c.badgeTone] || BADGE.slate}`}>{c.badge}</span>}
        {c.meta && <span className="ml-auto font-bold text-slate-900">{c.meta}</span>}
      </div>
      {c.barPct != null && (
        <div className="my-2.5 h-2 overflow-hidden rounded-full bg-slate-100">
          <div className="h-full rounded-full bg-gradient-to-r from-brand-500 to-brand-600" style={{ width: `${Math.max(0, Math.min(100, c.barPct))}%` }} />
        </div>
      )}
      {(c.lines || []).map((l, i) => <div key={i} className="text-[13px] text-slate-600">{l.label && <strong className="text-slate-700">{l.label}: </strong>}{l.value}</div>)}
      {c.body && <p className="mt-1 text-sm leading-relaxed text-slate-600">{c.body}</p>}
    </div>
  );
}

// Downloadable code/text card (llms.txt, schema JSON-LD, optimised content).
function CodeBlock({ title, filename, content }) {
  const download = () => {
    const blob = new Blob([content || ''], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename || 'file.txt';
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  };
  const btn = 'rounded-md border border-slate-600 bg-slate-800 px-2 py-0.5 text-xs font-medium text-slate-200 hover:bg-slate-700';
  return (
    <Block title={title}>
      <div className="overflow-hidden rounded-xl border border-slate-700 bg-slate-900 shadow-sm">
        <div className="flex items-center gap-2 border-b border-slate-700/70 px-3 py-2">
          <span className="flex gap-1.5" aria-hidden>
            <span className="h-2.5 w-2.5 rounded-full bg-red-400/80" />
            <span className="h-2.5 w-2.5 rounded-full bg-amber-400/80" />
            <span className="h-2.5 w-2.5 rounded-full bg-emerald-400/80" />
          </span>
          <span className="ml-1 font-mono text-xs text-slate-400">{filename || 'file.txt'}</span>
          <div className="ml-auto flex gap-1.5">
            <button onClick={() => copyText(content).then(() => toast('Copied to clipboard', 'success'))} className={btn}>Copy</button>
            <button onClick={download} className={btn}>Download</button>
          </div>
        </div>
        <pre className="max-h-96 overflow-auto whitespace-pre-wrap px-4 py-3 font-mono text-[13px] leading-relaxed text-slate-200">{content}</pre>
      </div>
    </Block>
  );
}

// A data table always shows its row count (top-right), alongside the title if
// one is given — so the reader knows the result size at a glance.
function TableSection({ s }) {
  const rows = Array.isArray(s.rows) ? s.rows : [];
  const n = rows.length;
  return (
    <div>
      <div className="mb-3 flex items-center gap-2">
        {s.title && (
          <h4 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-slate-700">
            <span className="h-3.5 w-1 rounded-full bg-brand-500" aria-hidden /> {s.title}
          </h4>
        )}
        <span className="ml-auto shrink-0 rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium tabular-nums text-slate-500">
          {n.toLocaleString()} {n === 1 ? 'row' : 'rows'}
        </span>
      </div>
      <Table columns={s.columns} rows={rows} exportName={s.title || 'table'} />
    </div>
  );
}

function Table({ columns, rows, exportName }) {
  const cols = columns.map((c) => ({ key: c, label: c, render: (r) => String(r[c] ?? '—') }));
  return <SortableTable columns={cols} rows={rows} filterable={rows.length > 8} exportName={exportName} />;
}
