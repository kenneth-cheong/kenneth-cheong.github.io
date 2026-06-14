import { useState, useMemo } from 'react';

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
}) {
  const cols = useMemo(() => {
    const base = columns || Object.keys(rows[0] || {}).map((k) => ({ key: k }));
    return base.map((c) => ({ sortable: true, align: 'left', ...c, label: c.label ?? humanise(c.key) }));
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
      <table className={`w-full text-left text-sm ${className}`}>
        <thead>
          <tr>
            {cols.map((c) => (
              <th
                key={c.key}
                onClick={() => onSort(c)}
                className={`sticky top-0 z-10 border-b border-slate-200 bg-slate-50 px-3 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500 ${c.align === 'right' ? 'text-right' : ''} ${c.sortable === false ? '' : 'cursor-pointer select-none hover:text-slate-700'}`}
              >
                {c.label}
                {sort.key === c.key && <span className="text-brand-500" aria-hidden> {sort.dir > 0 ? '▲' : '▼'}</span>}
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
              className={`border-t border-slate-100 transition-colors hover:bg-brand-50/40 ${zebra && i % 2 ? 'bg-slate-50/50' : ''} ${onRowClick ? 'cursor-pointer' : ''}`}
            >
              {cols.map((c) => (
                <td key={c.key} className={`px-3 py-2 ${c.align === 'right' ? 'text-right' : ''}`}>
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
