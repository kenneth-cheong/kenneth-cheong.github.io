import LineChart from './LineChart.jsx';
import TrendChart from './TrendChart.jsx';
import SortableTable from './SortableTable.jsx';
import ReportHtml from './ReportHtml.jsx';
import { copyText, toast } from '../lib/ui.js';
import InfoTip, { glossaryFor } from './InfoTip.jsx';
import RecommendationCard from './RecommendationCard.jsx';
import { useEffect, useState } from 'react';
import { Check, X, Info, TrendingUp, TrendingDown, ChevronRight } from 'lucide-react';

// Themed renderer for the structured `sections` result format. Turns the raw
// section data (stats / lists / tables / cards / code …) into a polished,
// scannable report: score gauges, keyword chips, pass/fail rows, accented
// section titles. Print-friendly and consistent with the app's blue theme.

// tone → colour treatments. `bg`/`border` tint stat & callout surfaces; `text`
// colours headline numbers; `stroke` paints the gauge arc.
const TONES = {
  green:  { bg: 'bg-emerald-50/70 dark:bg-emerald-500/10', border: 'border-emerald-100 dark:border-emerald-500/25', text: 'text-emerald-700 dark:text-emerald-300', chip: 'bg-emerald-100 dark:bg-emerald-500/15 text-emerald-700 dark:text-emerald-300', stroke: '#059669' },
  amber:  { bg: 'bg-amber-50/70 dark:bg-amber-500/10',   border: 'border-amber-100 dark:border-amber-500/25',   text: 'text-amber-700 dark:text-amber-300',   chip: 'bg-amber-100 dark:bg-amber-500/15 text-amber-700 dark:text-amber-300',   stroke: '#d97706' },
  red:    { bg: 'bg-red-50/70 dark:bg-red-500/10',     border: 'border-red-100 dark:border-red-500/25',     text: 'text-red-700 dark:text-red-300',     chip: 'bg-red-100 dark:bg-red-500/15 text-red-700 dark:text-red-300',       stroke: '#dc2626' },
  blue:   { bg: 'bg-brand-50/70 dark:bg-brand-500/10',   border: 'border-brand-100 dark:border-brand-500/25',   text: 'text-brand-700 dark:text-brand-300',   chip: 'bg-brand-100 dark:bg-brand-500/15 text-brand-700 dark:text-brand-300',   stroke: '#2563eb' },
  orange: { bg: 'bg-orange-50/70 dark:bg-orange-500/10',  border: 'border-orange-100 dark:border-orange-500/25',  text: 'text-orange-700 dark:text-orange-300',  chip: 'bg-orange-100 dark:bg-orange-500/15 text-orange-700 dark:text-orange-300', stroke: '#ea580c' },
  slate:  { bg: 'bg-raised',      border: 'border-line',   text: 'text-heading',   chip: 'bg-sunken text-dim',   stroke: '#64748b' },
};
const tone = (t) => TONES[t] || TONES.slate;

export default function ResultSections({ sections, context }) {
  return <div className="space-y-6">{sections.map((s, i) => <Section key={i} s={s} context={context} />)}</div>;
}

// Accented sub-section title — a small brand bar gives the report visual rhythm.
function Title({ children }) {
  if (!children) return null;
  return (
    <h4 className="mb-3 flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-body">
      <span className="h-3.5 w-1 rounded-full bg-brand-500" aria-hidden /> {children}
    </h4>
  );
}
function Block({ title, children }) { return <div>{title && <Title>{title}</Title>}{children}</div>; }

function Section({ s, context }) {
  switch (s.type) {
    case 'heading':
      return <h3 className="border-b border-hair pb-2 text-xl font-bold tracking-tight text-heading">{s.text}</h3>;
    case 'callout':
      return (
        <div className="flex items-start gap-2.5 rounded-xl border border-brand-100 dark:border-brand-500/25 bg-brand-50/60 dark:bg-brand-500/10 px-4 py-3 text-sm text-body">
          <Info size={16} className="mt-0.5 shrink-0 text-brand-500" aria-hidden />
          <span>{s.text}</span>
        </div>
      );
    case 'text':
      return <p className="text-sm leading-relaxed text-muted">{s.text}</p>;
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
          {s.note && <p className="-mt-1 mb-3 text-sm text-muted">{s.note}</p>}
          <div className="space-y-2.5">
            {s.items.map((c, i) => (c && c.body
              ? <RecommendationCard key={i} card={c} sectionTitle={s.title} context={context} />
              : <Card key={i} c={c} />))}
          </div>
        </Block>
      );
    case 'accordion':
      return <AccordionSection s={s} />;
    case 'table':
      return <TableSection s={s} />;
    case 'code':
      return <CodeBlock title={s.title} filename={s.filename} content={s.content} />;
    case 'html':
      // Server-rendered rich content (e.g. the Content Optimiser's draft) —
      // themed for dark mode by ReportHtml, scrolls inside its own frame.
      return (
        <Block title={s.title}>
          <div className="flex justify-end -mb-1">
            <button
              type="button"
              onClick={() => { const d = document.createElement('div'); d.innerHTML = s.html || ''; copyText(d.innerText).then(() => toast('Copied to clipboard', 'success')); }}
              className="dm-no-print rounded-md border border-line bg-surface px-2 py-0.5 text-xs font-medium text-dim hover:text-brand-600 dark:hover:text-brand-400"
            >Copy text</button>
          </div>
          <div className="mt-1 max-h-[560px] overflow-auto rounded-xl border border-line bg-surface p-4">
            <ReportHtml html={s.html} />
          </div>
        </Block>
      );
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
  const isEmpty = it.value == null || ['', '—', '-', 'n/a', 'na'].includes(String(it.value).trim().toLowerCase());
  return (
    <div className={`rounded-xl border ${t.border} ${t.bg} p-3.5`}>
      <div className="flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wide text-muted">
        <span>{it.label}</span>
        {def && <InfoTip text={def} size={12} />}
      </div>
      {pct != null
        ? <div className="mt-1.5"><Gauge pct={pct} stroke={t.stroke} /></div>
        : isEmpty
        ? <div className="mt-1 flex items-center gap-1 text-2xl font-bold leading-tight text-slate-300">—<InfoTip text="Not available — this metric couldn’t be measured for this site or page." size={14} /></div>
        : <div className={`mt-1 text-2xl font-bold leading-tight ${t.text}`}>{it.value}</div>}
      {it.delta && (
        <div className={`mt-1.5 inline-flex items-center gap-1 text-xs font-semibold ${it.deltaTone === 'red' ? 'text-red-600 dark:text-red-400' : it.deltaTone === 'green' ? 'text-emerald-600 dark:text-emerald-400' : 'text-faint'}`}>
          {it.deltaTone === 'green' ? <TrendingUp size={13} aria-hidden /> : it.deltaTone === 'red' ? <TrendingDown size={13} aria-hidden /> : null}
          {it.delta}<span className="ml-0.5 font-normal text-faint">vs prev</span>
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
              <span className="w-36 shrink-0 truncate text-dim" title={k.label}>{k.label}</span>
              <div className="h-2 flex-1 overflow-hidden rounded-full bg-sunken">
                <div className="h-full rounded-full bg-gradient-to-r from-brand-400 to-brand-600" style={{ width: `${Math.max(2, (k.value / max) * 100)}%` }} />
              </div>
              <span className="w-16 shrink-0 text-right font-semibold tabular-nums text-body">{k.raw}</span>
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
              <div key={i} className="flex items-start gap-2.5 text-sm text-body">
                <span className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full ${ok ? 'bg-emerald-100 dark:bg-emerald-500/15 text-emerald-600 dark:text-emerald-400' : 'bg-red-100 dark:bg-red-500/15 text-red-600 dark:text-red-400'}`}>
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
          {items.map((x, i) => <span key={i} className="inline-flex items-center rounded-full bg-sunken px-3 py-1 text-[13px] font-medium text-body">{x}</span>)}
        </div>
      </Block>
    );
  }

  const textColor = s.tone === 'green' ? 'text-emerald-700 dark:text-emerald-300' : s.tone === 'red' ? 'text-red-700 dark:text-red-300' : 'text-dim';
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
  red: 'bg-red-100 dark:bg-red-500/15 text-red-700 dark:text-red-300', amber: 'bg-amber-100 dark:bg-amber-500/15 text-amber-700 dark:text-amber-300', green: 'bg-emerald-100 dark:bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
  blue: 'bg-brand-100 dark:bg-brand-500/15 text-brand-700 dark:text-brand-300', orange: 'bg-orange-100 dark:bg-orange-500/15 text-orange-700 dark:text-orange-300', slate: 'bg-sunken text-dim',
};
function Card({ c }) {
  return (
    <div className="rounded-xl border border-line bg-surface p-3.5 transition-shadow hover:shadow-sm">
      <div className="flex flex-wrap items-center gap-2">
        <strong className="text-strong">{c.title}</strong>
        {c.badge && <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${BADGE[c.badgeTone] || BADGE.slate}`}>{c.badge}</span>}
        {c.meta && <span className="ml-auto font-bold text-heading">{c.meta}</span>}
      </div>
      {c.barPct != null && (
        <div className="my-2.5 h-2 overflow-hidden rounded-full bg-sunken">
          <div className="h-full rounded-full bg-gradient-to-r from-brand-500 to-brand-600" style={{ width: `${Math.max(0, Math.min(100, c.barPct))}%` }} />
        </div>
      )}
      {(c.lines || []).map((l, i) => <div key={i} className="text-[13px] text-dim">{l.label && <strong className="text-body">{l.label}: </strong>}{l.value}</div>)}
      {c.body && <p className="mt-1 text-sm leading-relaxed text-dim">{c.body}</p>}
    </div>
  );
}

// ── Accordion (e.g. the Content Optimiser's per-agent QA checks) ─────────────
// Many independent analyses that each carry a long write-up. Rendered open they
// merge into one unbroken column, so the surface is score + verdict and the
// detail opens on demand. Printing expands everything.
function AccordionSection({ s }) {
  const items = (s.items || []).filter(Boolean);
  const [open, setOpen] = useState(() => new Set());
  const allOpen = open.size === items.length && items.length > 0;
  const toggleAll = () => setOpen(allOpen ? new Set() : new Set(items.map((_, i) => i)));
  useEffect(() => {
    const expand = () => setOpen(new Set(items.map((_, i) => i)));
    window.addEventListener('beforeprint', expand);
    return () => window.removeEventListener('beforeprint', expand);
  }, [items.length]);
  if (!items.length) return null;
  return (
    <div>
      <div className="mb-3 flex items-center gap-2">
        {s.title && (
          <h4 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-body">
            <span className="h-3.5 w-1 rounded-full bg-brand-500" aria-hidden /> {s.title}
          </h4>
        )}
        <button type="button" onClick={toggleAll} className="dm-no-print ml-auto shrink-0 rounded-md border border-line bg-surface px-2 py-0.5 text-xs font-medium text-dim hover:text-brand-600 dark:hover:text-brand-400">
          {allOpen ? 'Collapse all' : 'Expand all'}
        </button>
      </div>
      {s.note && <p className="-mt-1 mb-3 text-sm text-muted">{s.note}</p>}
      <div className="space-y-2">
        {items.map((it, i) => (
          <AccordionRow key={i} it={it} open={open.has(i)} onToggle={() => setOpen((prev) => {
            const next = new Set(prev);
            if (next.has(i)) next.delete(i); else next.add(i);
            return next;
          })} />
        ))}
      </div>
    </div>
  );
}

function AccordionRow({ it, open, onToggle }) {
  return (
    <div className="overflow-hidden rounded-xl border border-line bg-surface">
      <button
        type="button" onClick={onToggle} aria-expanded={open}
        className="flex w-full items-center gap-2.5 px-3.5 py-2.5 text-left transition-colors hover:bg-sunken/60"
      >
        <ChevronRight size={15} aria-hidden className={`shrink-0 text-faint transition-transform ${open ? 'rotate-90' : ''}`} />
        <strong className="min-w-0 flex-1 truncate text-strong">{it.title}</strong>
        {it.group && <span className="hidden shrink-0 rounded-full bg-sunken px-2 py-0.5 text-[11px] font-medium text-muted sm:inline">{it.group}</span>}
        {it.meta && <span className="shrink-0 text-xs text-muted">{it.meta}</span>}
        {it.badge && <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-semibold ${BADGE[it.badgeTone] || BADGE.slate}`}>{it.badge}</span>}
      </button>
      {open && (
        <div className="border-t border-hair px-3.5 py-3">
          {it.summary && <p className="text-sm leading-relaxed text-dim">{it.summary}</p>}
          {!!(it.lines || []).length && (
            <ul className={`space-y-1.5 text-sm ${it.summary ? 'mt-3' : ''}`}>
              {it.lines.map((l, i) => (
                <li key={i} className="flex gap-2.5">
                  <span className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-brand-400" aria-hidden />
                  <span className="text-dim">{l.label && <strong className="uppercase text-[11px] tracking-wide text-body">{l.label} </strong>}{l.value}</span>
                </li>
              ))}
            </ul>
          )}
          {it.html && (
            <div className="mt-3 max-h-[420px] overflow-auto rounded-lg border border-line bg-sunken/40 p-3">
              <ReportHtml html={it.html} />
            </div>
          )}
        </div>
      )}
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
          <span className="ml-1 font-mono text-xs text-faint">{filename || 'file.txt'}</span>
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
          <h4 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-body">
            <span className="h-3.5 w-1 rounded-full bg-brand-500" aria-hidden /> {s.title}
          </h4>
        )}
        <span className="ml-auto shrink-0 rounded-full bg-sunken px-2 py-0.5 text-xs font-medium tabular-nums text-muted">
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
