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

  async function open(runId) {
    setOpening(runId);
    try {
      const { run } = await api.run(runId);
      navigate(`/tool/${run.tool}`, { state: { values: run.inputs, result: run.result } });
    } catch {
      setOpening(null);
    }
  }

  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="text-2xl font-bold">Run history</h1>
      <p className="mt-1 text-slate-600">Every tool run is saved here. Open one to revisit the result and the exact inputs.</p>

      {active && (
        <div className="mt-4 flex gap-2">
          {['all', 'project'].map((s) => (
            <button key={s} onClick={() => setScope(s)}
              className={`rounded-full px-3 py-1.5 text-sm font-medium ${scope === s ? 'bg-brand-600 text-white' : 'bg-white text-slate-600 ring-1 ring-slate-200 hover:bg-slate-50'}`}>
              {s === 'all' ? 'All runs' : active.name}
            </button>
          ))}
        </div>
      )}

      <div className="mt-6 space-y-2">
        {visible === null && <p className="text-slate-400">Loading…</p>}
        {visible?.length === 0 && (
          <div className="card p-8 text-center text-slate-400">No runs yet — run a tool and it'll appear here.</div>
        )}
        {visible?.map((r) => (
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
                {r.preview ? ` · ${r.preview}` : ''}
                {projName(r.projectId) ? ` · ${projName(r.projectId)}` : ''}
              </div>
            </div>
            {r.creditsUsed > 0 && <span className="text-xs text-slate-400">{r.creditsUsed} cr</span>}
            <span className="text-brand-500">{opening === r.runId ? '…' : 'Open →'}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
