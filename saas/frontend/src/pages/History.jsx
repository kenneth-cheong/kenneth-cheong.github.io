import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { toolById } from '@shared/catalog.mjs';
import { api } from '../lib/api.js';
import { useProjects } from '../context/ProjectContext.jsx';
import SortableTable from '../components/SortableTable.jsx';

// Derive a coarse run status from the saved preview (the list projection doesn't
// include the full result): empty/0-rows → No data; error-ish text → Issue.
function statusOf(r) {
  const p = (r.preview || '').toLowerCase().trim();
  // Error-ish text first (e.g. "couldn't pull live data — reconnect…").
  if (/couldn.?t|could not|unable|fail|error|reconnect|not connected|disconnect/.test(p)) {
    return { label: 'Issue', cls: 'bg-amber-100 dark:bg-amber-500/15 text-amber-700 dark:text-amber-300' };
  }
  // An explicit zero-row count is genuinely empty. (An empty preview just means
  // the result format — e.g. `sections` — isn't captured in the preview, so we
  // treat it as OK rather than mislabel a successful content run.)
  if (/^0 rows?\b|^0$/.test(p)) return { label: 'No data', cls: 'bg-sunken text-muted' };
  return { label: 'OK', cls: 'bg-green-100 dark:bg-green-500/15 text-green-700 dark:text-green-300' };
}

// Every tool run is saved server-side; clicking one re-opens it in the tool
// with the original inputs and the saved result (no re-run, no extra credits).
// `embedded` renders it as a section (no page width wrapper) so it can sit below
// Projects on the merged workspace page; the parent owns the max-width.
export default function History({ embedded = false }) {
  const [runs, setRuns] = useState(null);
  const [opening, setOpening] = useState(null);
  const [scope, setScope] = useState('all'); // 'all' | 'project'
  const [groupBy, setGroupBy] = useState('none'); // 'none' | 'tool' | 'target'
  const { projects, active, activeId } = useProjects();
  const navigate = useNavigate();
  const projName = (id) => projects.find((p) => p.projectId === id)?.name;

  useEffect(() => {
    // Ask for the full history — this page tells the user every run is here.
    api.runs(500).then((d) => setRuns(d.runs || [])).catch(() => setRuns([]));
  }, []);

  const visible = useMemo(() => {
    if (!runs) return runs;
    return scope === 'project' && activeId ? runs.filter((r) => r.projectId === activeId) : runs;
  }, [runs, scope, activeId]);

  // Bucket the visible runs by tool or by target webpage/domain, biggest first.
  const groups = useMemo(() => {
    if (!visible || groupBy === 'none') return null;
    const map = new Map();
    for (const r of visible) {
      const key = groupBy === 'tool'
        ? (toolById(r.tool)?.name || r.toolName || r.tool)
        : (r.target || 'No target');
      if (!map.has(key)) map.set(key, { key, runs: [], credits: 0, latest: r.ts });
      const g = map.get(key);
      g.runs.push(r);
      g.credits += r.creditsUsed || 0;
      if (r.ts > g.latest) g.latest = r.ts;
    }
    return [...map.values()].sort((a, b) => (b.runs.length - a.runs.length) || String(b.latest).localeCompare(String(a.latest)));
  }, [visible, groupBy]);

  async function open(runId) {
    setOpening(runId);
    try {
      const { run } = await api.run(runId);
      navigate(`/tool/${run.tool}`, { state: { values: run.inputs, result: run.result, runId } });
    } catch {
      setOpening(null);
    }
  }

  const columns = [
    { key: 'tool', label: 'Tool', accessor: (r) => toolById(r.tool)?.name || r.toolName || r.tool,
      render: (r) => <span className="font-medium text-strong">{toolById(r.tool)?.name || r.toolName || r.tool}</span> },
    { key: 'target', label: 'Target', accessor: (r) => r.target || '',
      render: (r) => (r.target ? <span className="text-dim">{r.target}</span> : <span className="text-slate-300">—</span>) },
    { key: 'status', label: 'Status', accessor: (r) => statusOf(r).label,
      render: (r) => { const s = statusOf(r); return <span className={`whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${s.cls}`}>{s.label}</span>; } },
    { key: 'ts', label: 'When', accessor: (r) => r.ts,
      render: (r) => <span className="whitespace-nowrap text-muted">{new Date(r.ts).toLocaleString()}</span> },
    { key: 'project', label: 'Project', accessor: (r) => projName(r.projectId) || '',
      render: (r) => (projName(r.projectId) ? <span className="text-muted">{projName(r.projectId)}</span> : <span className="text-slate-300">—</span>) },
    { key: 'creditsUsed', label: 'Credits', align: 'right', numeric: true,
      render: (r) => (r.creditsUsed > 0 ? r.creditsUsed : <span className="text-slate-300">—</span>) },
    { key: 'open', label: '', sortable: false, align: 'right',
      render: (r) => <span className="whitespace-nowrap text-brand-500">{opening === r.runId ? '…' : 'Open →'}</span> },
  ];

  const Table = ({ rows }) => (
    <SortableTable
      columns={columns}
      rows={rows}
      rowKey={(r) => r.runId}
      onRowClick={(r) => open(r.runId)}
      maxHeight="none"
    />
  );

  return (
    <div className={embedded ? '' : 'mx-auto max-w-5xl'} id={embedded ? 'runs' : undefined}>
      <h1 className="text-2xl font-bold">Runs</h1>
      <p className="mt-1 text-dim">Every tool run is saved here. Click a row to revisit the result and the exact inputs.</p>

      <div className="mt-4 flex flex-wrap items-center gap-x-6 gap-y-2">
        {active && (
          <div className="flex gap-2">
            {['all', 'project'].map((s) => (
              <button key={s} onClick={() => setScope(s)}
                className={`rounded-full px-3 py-1.5 text-sm font-medium ${scope === s ? 'bg-brand-600 text-white' : 'bg-surface text-dim ring-1 ring-line hover:bg-raised'}`}>
                {s === 'all' ? 'All runs' : active.name}
              </button>
            ))}
          </div>
        )}
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted">Group by</span>
          {[['none', 'None'], ['tool', 'Tool'], ['target', 'Domain']].map(([v, label]) => (
            <button key={v} onClick={() => setGroupBy(v)}
              className={`rounded-full px-3 py-1.5 text-sm font-medium ${groupBy === v ? 'bg-slate-800 text-white' : 'bg-surface text-dim ring-1 ring-line hover:bg-raised'}`}>
              {label}
            </button>
          ))}
        </div>
      </div>

      {visible === null && <p className="mt-6 text-faint">Loading…</p>}
      {visible?.length === 0 && (
        <div className="card mt-6 p-8 text-center">
          <p className="font-semibold text-heading">No runs yet</p>
          <p className="mt-1.5 text-sm text-dim">Everything you run is saved here, so you can re-open or re-run any result later.</p>
          <Link to="/" className="btn-primary mt-4 inline-block text-sm">Run your first tool →</Link>
        </div>
      )}

      {/* Flat sortable table */}
      {groups === null && visible?.length > 0 && (
        <div className="mt-6"><Table rows={visible} /></div>
      )}

      {/* Grouped by tool or target domain — a table per bucket */}
      {groups !== null && (
        <div className="mt-6 space-y-6">
          {groups.map((g) => (
            <div key={g.key}>
              <div className="mb-2 flex items-center gap-2">
                <h2 className="text-sm font-semibold uppercase tracking-wide text-body">{g.key}</h2>
                <span className="rounded-full bg-sunken px-2 py-0.5 text-xs font-medium text-muted">{g.runs.length} run{g.runs.length === 1 ? '' : 's'}</span>
                {g.credits > 0 && <span className="text-xs text-faint">{g.credits} cr</span>}
              </div>
              <Table rows={g.runs} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
