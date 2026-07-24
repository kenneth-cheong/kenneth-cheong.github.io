import { useState, useMemo, useEffect, useRef, cloneElement, isValidElement } from 'react';
import { Search, Columns3 } from 'lucide-react';
import InfoTip, { glossaryFor } from './InfoTip.jsx';
import { usePrinting } from '../lib/ui.js';

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
//
// `pageSize` (opt-in) pages the table; filter → sort → page, in that order, so
// sorting always reorders the whole set rather than just the visible page.
// `defaultSort` ({key, dir}) seeds the initial order.
const humanise = (k) => String(k).replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
const toNum = (v) => parseFloat(String(v ?? '').replace(/[^0-9.-]/g, ''));

// Mark every occurrence of `q` inside a plain-text cell.
//
// The box was labelled "Filter rows" but behaved like a search — it hid
// non-matching rows and then left you to find the match yourself in the rows
// that survived. Naming it Search settles what it is; marking the hit is what
// makes it useful, because on a wide table "this row matches somewhere" is not
// an answer.
//
// Applied to plain cells, and to the ONE custom-render shape that is still just
// text: an element whose children is a string, e.g.
// `<span className="text-dim">{r.target}</span>`. That pattern turns out to be
// the norm rather than the exception — every column in the Runs table uses it
// purely for styling — so skipping all custom renders meant the highlight never
// fired on the table people search most. Cloning the element preserves its
// styling and swaps only the text.
//
// Anything else (a link, a chart, nested nodes) is left exactly as the column
// built it: rebuilding those from their text would throw the markup away.
function highlightNode(node, q) {
  if (!q.trim()) return node;
  if (typeof node === 'string' || typeof node === 'number') return highlight(node, q);
  if (isValidElement(node) && typeof node.props?.children === 'string') {
    return cloneElement(node, undefined, highlight(node.props.children, q));
  }
  return node;
}

function highlight(text, q) {
  const s = String(text);
  const t = q.trim();
  if (!t) return s;
  const i = s.toLowerCase().indexOf(t.toLowerCase());
  if (i < 0) return s;
  const out = [];
  let at = 0, n = 0;
  for (let j = i; j >= 0; j = s.toLowerCase().indexOf(t.toLowerCase(), at)) {
    if (j > at) out.push(s.slice(at, j));
    out.push(
      <mark key={n++} className="rounded-[3px] bg-amber-200 px-0.5 text-inherit dark:bg-amber-400/30">
        {s.slice(j, j + t.length)}
      </mark>,
    );
    at = j + t.length;
  }
  if (at < s.length) out.push(s.slice(at));
  return out;
}

// "Columns ▾" — show/hide any column on a wide table. The backend can hand back
// far more per row than fits on screen (the site crawler returns ~35 fields per
// page); this is what makes the rest of them reachable instead of dropped.
//
// The list has its own search box because at ~35 entries scanning it is its own
// chore, and the last column can't be unticked: a table with no columns is a
// blank box with no way back other than Reset.
function ColumnPicker({ cols, shown, onChange, onReset }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const rootRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    setQ(''); // a stale filter would reopen the list showing four of forty columns
    const onDocClick = (e) => { if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  const toggle = (key) => onChange((prev) => {
    const next = new Set(prev);
    if (next.has(key)) { if (next.size > 1) next.delete(key); } else next.add(key);
    return next;
  });

  const t = q.trim().toLowerCase();
  const listed = t ? cols.filter((c) => c.label.toLowerCase().includes(t) || c.key.toLowerCase().includes(t)) : cols;

  return (
    <div ref={rootRef} className="relative ml-auto">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="true"
        className="inline-flex items-center gap-1.5 rounded-md border border-edge px-2.5 py-1 text-xs font-medium text-dim hover:border-brand-300 dark:hover:border-brand-500/40 hover:text-brand-600 dark:hover:text-brand-400"
      >
        <Columns3 size={13} aria-hidden /> Columns
        <span className="tabular-nums text-faint">{shown.size}/{cols.length}</span>
      </button>
      {open && (
        <div className="absolute right-0 z-30 mt-1 w-64 rounded-xl border border-line bg-surface p-2 shadow-lg">
          <input
            value={q} onChange={(e) => setQ(e.target.value)} autoFocus
            placeholder="Find a column…" aria-label="Find a column"
            className="mb-2 w-full rounded-lg border border-edge px-2.5 py-1.5 text-sm focus:border-brand-500 focus:outline-none"
          />
          <div className="max-h-64 overflow-auto">
            {listed.length === 0 && <p className="px-1 py-3 text-center text-xs text-faint">No matching column</p>}
            {listed.map((c) => (
              <label key={c.key} className="flex cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 text-sm text-dim hover:bg-sunken">
                <input type="checkbox" checked={shown.has(c.key)} onChange={() => toggle(c.key)} className="accent-brand-600" />
                <span className="truncate" title={c.label}>{c.label}</span>
              </label>
            ))}
          </div>
          <div className="mt-2 flex gap-2 border-t border-hair pt-2 text-xs font-medium">
            <button onClick={() => onChange(new Set(cols.map((c) => c.key)))} className="text-brand-600 dark:text-brand-400 hover:underline">Select all</button>
            <button onClick={onReset} className="ml-auto text-muted hover:underline">Reset</button>
          </div>
        </div>
      )}
    </div>
  );
}

// Cell wrapper that clamps to three lines on picker tables and is a no-op
// everywhere else — so no existing table's cells change shape.
const CellBox = ({ on, children }) => (on ? <div className="line-clamp-3">{children}</div> : children);

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
  pageSize = 0, // opt-in: rows per page (0 = show everything, the default)
  defaultSort, // opt-in: {key, dir} to sort by on first render (dir: 1 asc, -1 desc)
  columnPicker = false, // opt-in: a "Columns" dropdown to show/hide columns
  defaultColumns, // opt-in: keys visible on first render (default: all of them)
}) {
  const allCols = useMemo(() => {
    const base = columns || Object.keys(rows[0] || {}).map((k) => ({ key: k }));
    return base.map((c) => {
      const label = c.label ?? humanise(c.key);
      return { sortable: true, align: 'left', ...c, label, tip: c.tip ?? glossaryFor(label) ?? glossaryFor(c.key) };
    });
  }, [columns, rows]);

  // Which columns are on screen. Only meaningful with `columnPicker`; without it
  // this is every column and nothing below can change that.
  const initialShown = () => new Set(
    columnPicker && defaultColumns?.length
      ? allCols.filter((c) => defaultColumns.includes(c.key)).map((c) => c.key)
      : allCols.map((c) => c.key),
  );
  const [shown, setShown] = useState(initialShown);
  const sig = allCols.map((c) => c.key).join(' ');
  // A new result reuses this component, so a stale `shown` from the previous
  // table would hide every column of the new one. Re-seed when the column set
  // itself changes — not on every render, which would undo the user's picks.
  const lastSig = useRef(sig);
  useEffect(() => {
    if (lastSig.current === sig) return;
    lastSig.current = sig;
    setShown(initialShown());
  }, [sig]); // eslint-disable-line react-hooks/exhaustive-deps

  const cols = useMemo(
    () => (columnPicker ? allCols.filter((c) => shown.has(c.key)) : allCols),
    [allCols, shown, columnPicker],
  );

  // Past a handful of columns the table stops fitting and starts scrolling
  // sideways, which needs sized, height-capped cells. Below that it should look
  // exactly like it did before the picker existed — so the sizing rules only
  // switch on once the user has actually widened it.
  const wide = columnPicker && cols.length > 8;

  const [sort, setSort] = useState(defaultSort ? { dir: 1, ...defaultSort } : { key: null, dir: 1 });
  const [q, setQ] = useState('');
  const [page, setPage] = useState(0);
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

  // Paging is applied LAST — after filter and sort — so sorting always reorders
  // the whole result set and then shows page 1 of it. Sorting only the current
  // page would be a lie: "sort by credits" would surface the biggest run on this
  // page, not the biggest run.
  // Paper has no "next page" button, so a PDF export renders every row. The
  // height cap is released by the print stylesheet; the rows themselves have to
  // come back here, because a paged table only ever has one page in the DOM.
  const printing = usePrinting();
  const pageCount = pageSize > 0 ? Math.max(1, Math.ceil(sorted.length / pageSize)) : 1;
  const current = Math.min(page, pageCount - 1); // stay in range when rows shrink
  const visible = pageSize > 0 && !printing ? sorted.slice(current * pageSize, current * pageSize + pageSize) : sorted;

  // Any change to what's being paged sends you back to the first page —
  // otherwise filtering a 400-row list while on page 12 shows an empty table.
  const reset = () => setPage(0);

  const onSort = (c) => {
    if (c.sortable === false) return;
    setSort((s) => ({ key: c.key, dir: s.key === c.key ? -s.dir : 1 }));
    reset();
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
      {(filterable || exportName || columnPicker) && (
        // Search box and CSV button are controls, not findings — they printed
        // as a dead input and a dead button at the top of every exported table.
        <div className="dm-no-print mb-2 flex items-center gap-2">
          {filterable && (
            // "Search", not "Filter rows": it matches across every column and
            // narrows to the hits, which is what people mean by search. Calling
            // it a filter set up the expectation of pickable facets.
            <div className="relative w-full max-w-xs">
              <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-faint" aria-hidden />
              <input
                value={q} onChange={(e) => { setQ(e.target.value); reset(); }}
                placeholder="Search this table…" aria-label="Search this table"
                className="w-full rounded-lg border border-edge py-1.5 pl-8 pr-2.5 text-sm focus:border-brand-500 focus:outline-none"
              />
            </div>
          )}
          {filterable && q && <span className="text-xs text-faint tabular-nums">{sorted.length.toLocaleString()} match{sorted.length === 1 ? '' : 'es'}</span>}
          {columnPicker && (
            <ColumnPicker
              cols={allCols}
              shown={shown}
              onChange={setShown}
              onReset={() => setShown(initialShown())}
            />
          )}
          {exportName && <button onClick={exportCsv} className={`rounded-md border border-edge px-2.5 py-1 text-xs font-medium text-dim hover:border-brand-300 dark:hover:border-brand-500/40 hover:text-brand-600 dark:hover:text-brand-400 ${columnPicker ? '' : 'ml-auto'}`}>CSV</button>}
        </div>
      )}
      {/* dm-print-open: paper can't scroll, so the print stylesheet releases the
          height cap here — otherwise the PDF showed an empty bordered box where
          a 50-row table should have been. */}
      <div className="dm-print-open overflow-auto rounded-xl border border-line" style={{ maxHeight }}>
      <table className={`${stickyFirstCol ? 'min-w-full' : 'w-full'} text-left text-sm ${className}`}>
        <thead>
          <tr>
            {cols.map((c, ci) => (
              <th
                key={c.key}
                onClick={() => onSort(c)}
                title={c.sortable === false ? undefined : `Sort by ${c.label}`}
                aria-sort={sort.key === c.key ? (sort.dir > 0 ? 'ascending' : 'descending') : undefined}
                className={`group sticky top-0 z-10 border-b border-line bg-raised px-3 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-muted ${c.align === 'right' ? 'text-right' : ''} ${c.sortable === false ? '' : 'cursor-pointer select-none hover:text-body'} ${stickyFirstCol ? 'whitespace-nowrap' : ''} ${stickyFirstCol && ci === 0 ? 'sticky left-0 z-20' : ''}`}
              >
                <span className={`inline-flex items-center gap-1 ${c.align === 'right' ? 'flex-row-reverse' : ''}`}>
                  {c.label}
                  {c.tip && <InfoTip text={c.tip} size={12} />}
                  {sort.key === c.key
                    ? <span className="text-brand-500" aria-hidden>{sort.dir > 0 ? '▲' : '▼'}</span>
                    // Columns gave no hint that they were clickable until after
                    // you'd already sorted one — surface it on hover.
                    : c.sortable !== false && <span className="opacity-0 transition-opacity group-hover:opacity-60" aria-hidden>↕</span>}
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && emptyText && (
            <tr><td colSpan={cols.length} className="px-3 py-8 text-center text-faint">{emptyText}</td></tr>
          )}
          {visible.map((row, pi) => {
            // Absolute index across all pages — a page-local one would collide
            // as a fallback key, and any `render` that numbers rows would
            // restart at 1 on every page.
            const i = (pageSize > 0 && !printing ? current * pageSize : 0) + pi;
            return (
            <tr
              key={rowKey ? rowKey(row, i) : i}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
              className={`group border-t border-hair transition-colors hover:bg-brand-50/40 dark:hover:bg-brand-500/10 ${zebra && i % 2 ? 'bg-raised/50' : ''} ${onRowClick ? 'cursor-pointer' : ''}`}
            >
              {cols.map((c, ci) => (
                <td
                  key={c.key}
                  // On a sideways-scrolling table, without a floor the browser
                  // squeezes text columns to one word per line; without a
                  // ceiling one prose column eats the width.
                  className={`px-3 py-2 ${wide ? 'min-w-[10rem] max-w-[22rem] align-top' : ''} ${c.align === 'right' ? 'text-right' : ''} ${stickyFirstCol && ci === 0 ? `sticky left-0 z-[1] transition-colors group-hover:bg-brand-50 dark:group-hover:bg-brand-500/10 ${zebra && i % 2 ? 'bg-raised' : 'bg-surface'}` : ''}`}
                >
                  {/* Three lines per cell keeps the row height predictable when
                      forty columns are on screen; the print stylesheet releases
                      the clamp so a PDF still carries the full text. */}
                  <CellBox on={wide}>
                    {c.render
                      ? highlightNode(c.render(row, i), q)
                      : (accessorOf(c)(row) == null || accessorOf(c)(row) === ''
                          ? '—'
                          : highlight(accessorOf(c)(row), q))}
                  </CellBox>
                </td>
              ))}
            </tr>
            );
          })}
        </tbody>
      </table>
      </div>
      {pageSize > 0 && sorted.length > 0 && (
        <div className="dm-no-print mt-2 flex flex-wrap items-center gap-2 text-sm">
          <span className="text-muted tabular-nums">
            {(current * pageSize + 1).toLocaleString()}–{Math.min((current + 1) * pageSize, sorted.length).toLocaleString()} of {sorted.length.toLocaleString()}
          </span>
          {pageCount > 1 && (
            <div className="ml-auto flex items-center gap-1">
              <button onClick={() => setPage(current - 1)} disabled={current === 0}
                className="rounded-md border border-edge px-2.5 py-1 font-medium text-dim enabled:hover:bg-raised disabled:opacity-40">
                ‹ Prev
              </button>
              <span className="px-1.5 text-muted tabular-nums">Page {current + 1} of {pageCount}</span>
              <button onClick={() => setPage(current + 1)} disabled={current >= pageCount - 1}
                className="rounded-md border border-edge px-2.5 py-1 font-medium text-dim enabled:hover:bg-raised disabled:opacity-40">
                Next ›
              </button>
            </div>
          )}
        </div>
      )}
    </>
  );
}
