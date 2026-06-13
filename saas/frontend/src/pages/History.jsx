import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { toolById } from '@shared/catalog.mjs';
import { api } from '../lib/api.js';

// Every tool run is saved server-side; clicking one re-opens it in the tool
// with the original inputs and the saved result (no re-run, no extra credits).
export default function History() {
  const [runs, setRuns] = useState(null);
  const [opening, setOpening] = useState(null);
  const navigate = useNavigate();

  useEffect(() => {
    api.runs().then((d) => setRuns(d.runs || [])).catch(() => setRuns([]));
  }, []);

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

      <div className="mt-6 space-y-2">
        {runs === null && <p className="text-slate-400">Loading…</p>}
        {runs?.length === 0 && (
          <div className="card p-8 text-center text-slate-400">No runs yet — run a tool and it'll appear here.</div>
        )}
        {runs?.map((r) => (
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
