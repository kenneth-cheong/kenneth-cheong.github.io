import { useState, useMemo } from 'react';
import InfoTip, { glossaryFor } from './InfoTip.jsx';

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
  filterable = false, // opt-in: a search box that filters rows across all columns
  exportName, // opt-in: when set, a CSV download button (filename base) appears
}) {
  const cols = useMemo(() => {
    const base = columns || Object.keys(rows[0] || {}).map((k) => ({ key: k }));
    return base.map((c) => {
      const label = c.label ?? humanise(c.key);
      return { sortable: true, align: 'left', ...c, label, tip: c.tip ?? glossaryFor(label) ?? glossaryFor(c.key) };
    });
  }, [columns, rows]);

  const [sort, setSort] = useState({ key: null, dir: 1 });
  const [q, setQ] = useState('');
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

  // Filter (across every column's displayed value) then sort.
  const filtered = useMemo(() => {
    const t = q.trim().toLowerCase();
    if (!t) return rows;
    return rows.filter((r) => cols.some((c) => String(accessorOf(c)(r) ?? '').toLowerCase().includes(t)));
  }, [rows, q, cols]);

  const sorted = useMemo(() => {
    if (!sort.key) return filtered;
    const col = cols.find((c) => c.key === sort.key);
    if (!col) return filtered;
    const get = accessorOf(col);
    const num = isNumeric(col);
    return [...filtered].sort((a, b) => {
      const av = get(a), bv = get(b);
      const cmp = num
        ? (toNum(av) || 0) - (toNum(bv) || 0)
        : String(av ?? '').localeCompare(String(bv ?? ''));
      return cmp * sort.dir;
    });
  }, [filtered, sort, cols]);

  const onSort = (c) => {
    if (c.sortable === false) return;
    setSort((s) => ({ key: c.key, dir: s.key === c.key ? -s.dir : 1 }));
  };

  // Export the CURRENTLY VISIBLE rows (filtered + sorted) to CSV.
  const exportCsv = () => {
    const esc = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const csv = [cols.map((c) => esc(c.label)).join(','), ...sorted.map((r) => cols.map((c) => esc(accessorOf(c)(r))).join(','))].join('\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    const a = document.createElement('a');
    a.href = url; a.download = `${String(exportName || 'table').replace(/[^\w.-]+/g, '_').slice(0, 60)}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  };

  return (
    <>
      {(filterable || exportName) && (
        <div className="mb-2 flex items-center gap-2">
          {filterable && (
            <input
              value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter rows…"
              className="w-full max-w-xs rounded-lg border border-edge px-2.5 py-1.5 text-sm focus:border-brand-500 focus:outline-none"
            />
          )}
          {filterable && q && <span className="text-xs text-faint tabular-nums">{sorted.length.toLocaleString()} match{sorted.length === 1 ? '' : 'es'}</span>}
          {exportName && <button onClick={exportCsv} className="ml-auto rounded-md border border-edge px-2.5 py-1 text-xs font-medium text-dim hover:border-brand-300 hover:text-brand-600">CSV</button>}
        </div>
      )}
      <div className="overflow-auto rounded-xl border border-line" style={{ maxHeight }}>
      <table className={`${stickyFirstCol ? 'min-w-full' : 'w-full'} text-left text-sm ${className}`}>
        <thead>
          <tr>
            {cols.map((c, ci) => (
              <th
                key={c.key}
                onClick={() => onSort(c)}
                className={`sticky top-0 z-10 border-b border-line bg-raised px-3 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-muted ${c.align === 'right' ? 'text-right' : ''} ${c.sortable === false ? '' : 'cursor-pointer select-none hover:text-body'} ${stickyFirstCol ? 'whitespace-nowrap' : ''} ${stickyFirstCol && ci === 0 ? 'sticky left-0 z-20' : ''}`}
              >
                <span className={`inline-flex items-center gap-1 ${c.align === 'right' ? 'flex-row-reverse' : ''}`}>
                  {c.label}
                  {c.tip && <InfoTip text={c.tip} size={12} />}
                  {sort.key === c.key && <span className="text-brand-500" aria-hidden>{sort.dir > 0 ? '▲' : '▼'}</span>}
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && emptyText && (
            <tr><td colSpan={cols.length} className="px-3 py-8 text-center text-faint">{emptyText}</td></tr>
          )}
          {sorted.map((row, i) => (
            <tr
              key={rowKey ? rowKey(row, i) : i}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
              className={`group border-t border-hair transition-colors hover:bg-brand-50/40 ${zebra && i % 2 ? 'bg-raised/50' : ''} ${onRowClick ? 'cursor-pointer' : ''}`}
            >
              {cols.map((c, ci) => (
                <td
                  key={c.key}
                  className={`px-3 py-2 ${c.align === 'right' ? 'text-right' : ''} ${stickyFirstCol && ci === 0 ? `sticky left-0 z-[1] transition-colors group-hover:bg-brand-50 ${zebra && i % 2 ? 'bg-raised' : 'bg-surface'}` : ''}`}
                >
                  {c.render ? c.render(row, i) : (accessorOf(c)(row) ?? '—')}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      </div>
    </>
  );
}
