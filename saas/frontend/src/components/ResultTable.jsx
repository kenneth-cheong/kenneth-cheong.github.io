import SortableTable from './SortableTable.jsx';
import { fmtNum } from '../lib/ui.js';

// The top-level `rows` result renderer, shared by ToolRunner (the live in-app
// result) and PublicRun (the read-only public share page) so a shared link
// looks pixel-for-pixel like the app. `cell` is exported too — KeywordAnalysis
// builds its own column set but reuses the same per-cell formatting.

const TONE = { red: 'bg-red-100 dark:bg-red-500/15 text-red-700 dark:text-red-300', amber: 'bg-amber-100 dark:bg-amber-500/15 text-amber-700 dark:text-amber-300', green: 'bg-green-100 dark:bg-green-500/15 text-green-700 dark:text-green-300', blue: 'bg-blue-100 dark:bg-blue-500/15 text-blue-700 dark:text-blue-300', slate: 'bg-sunken text-dim' };
function Badge({ t, tone }) { return <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${TONE[tone] || TONE.slate}`}>{t}</span>; }

function timeToRankClass(s) {
  const t = String(s).toLowerCase();
  if (t.startsWith('0-3')) return 'bg-green-100 dark:bg-green-500/15 text-green-700 dark:text-green-300';
  if (t.startsWith('3-6')) return 'bg-lime-100 dark:bg-lime-500/15 text-lime-700 dark:text-lime-300';
  if (t.startsWith('6-9')) return 'bg-amber-100 dark:bg-amber-500/15 text-amber-700 dark:text-amber-300';
  if (t.startsWith('9-12')) return 'bg-orange-100 dark:bg-orange-500/15 text-orange-700 dark:text-orange-300';
  if (t.includes('more than 12')) return 'bg-red-100 dark:bg-red-500/15 text-red-700 dark:text-red-300';
  return 'bg-sunken text-muted';
}

export function cell(col, val) {
  const c = col.toLowerCase();
  const s = String(val ?? '');
  if (!s || s === '—') return <span className="text-faint">—</span>;
  if (c === 'timetorank') return <span className={`inline-block whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${timeToRankClass(s)}`}>{s}</span>;
  if (c === 'priority') return <Badge t={s} tone={{ critical: 'red', high: 'amber', medium: 'blue', keep: 'slate' }[s.toLowerCase()]} />;
  if (c === 'severity') return <Badge t={s} tone={{ critical: 'red', high: 'red', medium: 'amber', low: 'green' }[s.toLowerCase()]} />;
  if (c === 'suitability') return <Badge t={s} tone={{ high: 'green', medium: 'amber', low: 'slate' }[s.toLowerCase()]} />;
  if (c === 'intent' || c === 'status' || c === 'type') return <Badge t={s} tone="slate" />;
  if (c === 'difficulty') { const n = parseFloat(s); if (Number.isFinite(n)) return <span className={n < 30 ? 'font-medium text-green-600 dark:text-green-400' : n < 60 ? 'font-medium text-amber-600 dark:text-amber-400' : 'font-medium text-red-600 dark:text-red-400'}>{n}</span>; }
  if (['volume', 'impressions', 'clicks', 'sessions', 'users', 'backlinks', 'traffic', 'conversions'].includes(c)) return <span className="tabular-nums">{fmtNum(s)}</span>;
  if (c === 'url' && /^https?:\/\//i.test(s)) return <a href={s} target="_blank" rel="noreferrer" className="break-all text-brand-600 dark:text-brand-400 hover:underline">{s.replace(/^https?:\/\//i, '')}</a>;
  // Prose columns (meta descriptions, joined H2s) run to hundreds of characters.
  // The full text stays the cell VALUE — search, sort and CSV export all still
  // see it — and picker tables clamp the display to three lines; this just makes
  // the whole thing reachable on hover.
  if (s.length > 140) return <span title={s}>{s}</span>;
  return s;
}

export default function ResultTable({ rows, defaultColumns }) {
  const columns = Object.keys(rows[0] || {}).map((c) => ({
    key: c,
    // Split camelCase boundaries so "timeToRank" reads "time To Rank" (→ header
    // "TIME TO RANK"); leaves already-cased keys ("CPC", "url", "keyword") intact.
    label: c.replace(/([a-z])([A-Z])/g, '$1 $2'),
    render: (row) => cell(c, row[c]),
  }));
  const n = rows.length;
  const picker = defaultColumns?.length > 0 && defaultColumns.length < columns.length;
  return (
    <div>
      <div className="mb-1.5 flex justify-end">
        <span className="rounded-full bg-sunken px-2 py-0.5 text-xs font-medium tabular-nums text-muted">
          {n.toLocaleString()} {n === 1 ? 'row' : 'rows'}
        </span>
      </div>
      <SortableTable
        columns={columns} rows={rows} filterable={rows.length > 8}
        columnPicker={picker} defaultColumns={defaultColumns} stickyFirstCol={picker}
      />
    </div>
  );
}
