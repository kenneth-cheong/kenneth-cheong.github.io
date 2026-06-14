import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { toolById } from '@shared/catalog.mjs';
import { api } from '../lib/api.js';
import { useProjects } from '../context/ProjectContext.jsx';

// Every tool run is saved server-side; clicking one re-opens it in the tool
// with the original inputs and the saved result (no re-run, no extra credits).
export default function History() {
  const [runs, setRuns] = useState(null);
  const [opening, setOpening] = useState(null);
  const [scope, setScope] = useState('all'); // 'all' | 'project'
  const [groupBy, setGroupBy] = useState('none'); // 'none' | 'tool' | 'target'
  const { projects, active, activeId } = useProjects();
  const navigate = useNavigate();
  const projName = (id) => projects.find((p) => p.projectId === id)?.name;

  useEffect(() => {
    api.runs().then((d) => setRuns(d.runs || [])).catch(() => setRuns([]));
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
      navigate(`/tool/${run.tool}`, { state: { values: run.inputs, result: run.result } });
    } catch {
      setOpening(null);
    }
  }

  const RunRow = (r) => (
    <button
      key={r.runId}
      onClick={() => open(r.runId)}
      disabled={opening === r.runId}
      className="card flex w-full items-center gap-4 p-4 text-left transition hover:border-brand-300 disabled:opacity-60"
    >
      <div className="min-w-0 flex-1">
        <div className="font-semibold">{toolById(r.tool)?.name || r.toolName || r.tool}</div>
        <div className="truncate text-sm text-slate-500">
          {new Date(r.ts).toLocaleString()}
          {groupBy !== 'target' && r.target ? ` · ${r.target}` : ''}
          {r.preview ? ` · ${r.preview}` : ''}
          {projName(r.projectId) ? ` · ${projName(r.projectId)}` : ''}
        </div>
      </div>
      {r.creditsUsed > 0 && <span className="text-xs text-slate-400">{r.creditsUsed} cr</span>}
      <span className="text-brand-500">{opening === r.runId ? '…' : 'Open →'}</span>
    </button>
  );

  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="text-2xl font-bold">Run history</h1>
      <p className="mt-1 text-slate-600">Every tool run is saved here. Open one to revisit the result and the exact inputs.</p>

      <div className="mt-4 flex flex-wrap items-center gap-x-6 gap-y-2">
        {active && (
          <div className="flex gap-2">
            {['all', 'project'].map((s) => (
              <button key={s} onClick={() => setScope(s)}
                className={`rounded-full px-3 py-1.5 text-sm font-medium ${scope === s ? 'bg-brand-600 text-white' : 'bg-white text-slate-600 ring-1 ring-slate-200 hover:bg-slate-50'}`}>
                {s === 'all' ? 'All runs' : active.name}
              </button>
            ))}
          </div>
        )}
        <div className="flex items-center gap-2">
          <span className="text-sm text-slate-500">Group by</span>
          {[['none', 'None'], ['tool', 'Tool'], ['target', 'Domain']].map(([v, label]) => (
            <button key={v} onClick={() => setGroupBy(v)}
              className={`rounded-full px-3 py-1.5 text-sm font-medium ${groupBy === v ? 'bg-slate-800 text-white' : 'bg-white text-slate-600 ring-1 ring-slate-200 hover:bg-slate-50'}`}>
              {label}
            </button>
          ))}
        </div>
      </div>

      {visible === null && <p className="mt-6 text-slate-400">Loading…</p>}
      {visible?.length === 0 && (
        <div className="card mt-6 p-8 text-center text-slate-400">No runs yet — run a tool and it'll appear here.</div>
      )}

      {/* Flat list */}
      {groups === null && visible?.length > 0 && (
        <div className="mt-6 space-y-2">{visible.map(RunRow)}</div>
      )}

      {/* Grouped by tool or target domain */}
      {groups !== null && (
        <div className="mt-6 space-y-6">
          {groups.map((g) => (
            <div key={g.key}>
              <div className="mb-2 flex items-center gap-2">
                <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-700">{g.key}</h2>
                <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-500">{g.runs.length} run{g.runs.length === 1 ? '' : 's'}</span>
                {g.credits > 0 && <span className="text-xs text-slate-400">{g.credits} cr</span>}
              </div>
              <div className="space-y-2">{g.runs.map(RunRow)}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
