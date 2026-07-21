import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../lib/api.js';

// Deep link to one saved run: /runs/:runId.
//
// "Media Plan Generator finished" in the notification bell points here, so the
// click lands on the actual result instead of the Runs list with the user left
// to find the row themselves. This page only resolves the run and hands off —
// it fetches the run, then replaces itself with the tool view seeded with the
// original inputs + saved result (same handoff History does on a row click, so
// there's no re-run and nothing extra is charged).
export default function OpenRun() {
  const { runId } = useParams();
  const navigate = useNavigate();
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    setError('');
    api.run(runId)
      .then(({ run }) => {
        if (!alive) return;
        // `replace` keeps this resolver out of history — Back from the result
        // goes wherever the user came from, not into a redirect loop.
        navigate(`/tool/${run.tool}`, { replace: true, state: { values: run.inputs, result: run.result, runId } });
      })
      .catch((e) => { if (alive) setError(e?.message || "We couldn't open that result."); });
    return () => { alive = false; };
  }, [runId]); // eslint-disable-line react-hooks/exhaustive-deps

  if (error) {
    return (
      <div className="mx-auto max-w-lg">
        <div className="card mt-10 p-8 text-center">
          <p className="font-semibold text-heading">That result isn&apos;t available</p>
          <p className="mt-1.5 text-sm text-dim">{error}</p>
          <p className="mt-1.5 text-sm text-faint">It may have been deleted, or the link belongs to another account.</p>
          <Link to="/history" className="btn-primary mt-4 inline-block text-sm">Browse all runs →</Link>
        </div>
      </div>
    );
  }

  return <p className="mt-10 text-center text-faint">Opening your result…</p>;
}
