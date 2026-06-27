import { useState, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Info } from 'lucide-react';
import { GLOSSARY } from '@shared/catalog.mjs';

// Shared data table with a STICKY header (stays put while the body scrolls) and
// CLICK-TO-SORT columns. Used everywhere a <table> renders tabular data so the
// behaviour is consistent.
//
// columns: [{
//   key,                      // unique id + default object key for the cell
//   label?,                   // header text (defaults to a humanised key)
//   align?: 'left' | 'right',
//   sortable?: boolean,       // default true
//   numeric?: boolean,        // force numeric sort (else auto-detected)
//   accessor?: (row) => any,  // value used for sorting (defaults to row[key])
//   render?: (row, i) => node // cell contents (defaults to the accessor value)
//   tip?: string              // header tooltip (defaults to a GLOSSARY match)
// }]
// If `columns` is omitted, they're inferred from the keys of the first row.
const humanise = (k) => String(k).replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
const toNum = (v) => parseFloat(String(v ?? '').replace(/[^0-9.-]/g, ''));

// Plain-English definition for a column header (case-insensitive), for header
// info tooltips. Matches the metric glossary used by the stat cards.
const glossaryFor = (label) => {
  const k = String(label || '').trim();
  if (!k) return null;
  if (GLOSSARY[k]) return GLOSSARY[k];
  const hit = Object.keys(GLOSSARY).find((g) => g.toLowerCase() === k.toLowerCase());
  return hit ? GLOSSARY[hit] : null;
};

// Header info icon with an INSTANT tooltip (no native `title` delay). The
// tooltip is portalled to <body> with position:fixed so the table's
// overflow-auto container can't clip it.
function InfoTip({ text }) {
  const ref = useRef(null);
  const [pos, setPos] = useState(null);
  const show = () => {
    const r = ref.current?.getBoundingClientRect();
    if (r) setPos({ x: r.left + r.width / 2, y: r.bottom + 6 });
  };
  return (
    <span
      ref={ref}
      onMouseEnter={show}
      onMouseLeave={() => setPos(null)}
      onClick={(e) => e.stopPropagation()}
      className="cursor-help text-slate-300 hover:text-slate-500"
      aria-label={text}
    >
      <Info size={12} aria-hidden />
      {pos && createPortal(
        <span
          style={{ position: 'fixed', left: pos.x, top: pos.y, transform: 'translateX(-50%)', zIndex: 70 }}
          className="pointer-events-none max-w-[220px] rounded-lg bg-slate-800 px-2.5 py-1.5 text-[11px] font-normal normal-case leading-snug tracking-normal text-white shadow-lg"
        >
          {text}
        </span>,
        document.body,
      )}
    </span>
  );
}

export default function SortableTable({
  columns,
  rows = [],
  rowKey,
  maxHeight = '32rem',
  zebra = true,
  emptyText,
  className = '',
  onRowClick, // optional: makes each row clickable
  stickyFirstCol = false, // opt-in: horizontal scroll with a pinned first column
}) {
  const cols = useMemo(() => {
    const base = columns || Object.keys(rows[0] || {}).map((k) => ({ key: k }));
    return base.map((c) => {
      const label = c.label ?? humanise(c.key);
      return { sortable: true, align: 'left', ...c, label, tip: c.tip ?? glossaryFor(label) ?? glossaryFor(c.key) };
    });
  }, [columns, rows]);

  const [sort, setSort] = useState({ key: null, dir: 1 });
  const accessorOf = (c) => c.accessor || ((row) => row[c.key]);

  const isNumeric = (c) => {
    if (typeof c.numeric === 'boolean') return c.numeric;
    const get = accessorOf(c);
    return rows.length > 0 && rows.every((r) => {
      const v = get(r);
      if (v === '' || v == null) return true;
      return !Number.isNaN(toNum(v));
    });
  };

  const sorted = useMemo(() => {
    if (!sort.key) return rows;
    const col = cols.find((c) => c.key === sort.key);
    if (!col) return rows;
    const get = accessorOf(col);
    const num = isNumeric(col);
    return [...rows].sort((a, b) => {
      const av = get(a), bv = get(b);
      const cmp = num
        ? (toNum(av) || 0) - (toNum(bv) || 0)
        : String(av ?? '').localeCompare(String(bv ?? ''));
      return cmp * sort.dir;
    });
  }, [rows, sort, cols]);

  const onSort = (c) => {
    if (c.sortable === false) return;
    setSort((s) => ({ key: c.key, dir: s.key === c.key ? -s.dir : 1 }));
  };

  return (
    <div className="overflow-auto rounded-xl border border-slate-200" style={{ maxHeight }}>
      <table className={`${stickyFirstCol ? 'min-w-full' : 'w-full'} text-left text-sm ${className}`}>
        <thead>
          <tr>
            {cols.map((c, ci) => (
              <th
                key={c.key}
                onClick={() => onSort(c)}
                className={`sticky top-0 z-10 border-b border-slate-200 bg-slate-50 px-3 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500 ${c.align === 'right' ? 'text-right' : ''} ${c.sortable === false ? '' : 'cursor-pointer select-none hover:text-slate-700'} ${stickyFirstCol && ci === 0 ? 'sticky left-0 z-20' : ''}`}
              >
                <span className={`inline-flex items-center gap-1 ${c.align === 'right' ? 'flex-row-reverse' : ''}`}>
                  {c.label}
                  {c.tip && <InfoTip text={c.tip} />}
                  {sort.key === c.key && <span className="text-brand-500" aria-hidden>{sort.dir > 0 ? '▲' : '▼'}</span>}
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && emptyText && (
            <tr><td colSpan={cols.length} className="px-3 py-8 text-center text-slate-400">{emptyText}</td></tr>
          )}
          {sorted.map((row, i) => (
            <tr
              key={rowKey ? rowKey(row, i) : i}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
              className={`group border-t border-slate-100 transition-colors hover:bg-brand-50/40 ${zebra && i % 2 ? 'bg-slate-50/50' : ''} ${onRowClick ? 'cursor-pointer' : ''}`}
            >
              {cols.map((c, ci) => (
                <td
                  key={c.key}
                  className={`px-3 py-2 ${c.align === 'right' ? 'text-right' : ''} ${stickyFirstCol && ci === 0 ? `sticky left-0 z-[1] transition-colors group-hover:bg-brand-50 ${zebra && i % 2 ? 'bg-slate-50' : 'bg-white'}` : ''}`}
                >
                  {c.render ? c.render(row, i) : (accessorOf(c)(row) ?? '—')}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
