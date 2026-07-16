import { useEffect, useState } from 'react';
import { api } from './api.js';

// Reads the LATEST stored run per tool and hands back its result.
//
// This is the whole persistence story, and it needs no new backend: every run
// is already durable in DynamoDB, so "the newest run for tool X" is a stable
// read. Re-run a tool and the next load shows the newer result automatically —
// nothing to invalidate, nothing to cache-bust. Cards never trigger a run
// themselves: a dashboard that runs tools on load would bill real credits on
// every visit.
//
// /me/runs returns metadata only (no `result`), so the full payload for each
// tool's newest run is fetched individually — one request per card, in parallel.

const norm = (r) => r?.run?.result ?? r?.result ?? null;

export function useLatestRuns(toolIds) {
  const key = toolIds.join(',');
  const [state, setState] = useState({ loading: true, byTool: {} });

  useEffect(() => {
    let dead = false;
    (async () => {
      try {
        const { runs = [] } = await api.runs();
        // Newest run per tool of interest.
        const newest = {};
        for (const r of runs) {
          if (!toolIds.includes(r.tool)) continue;
          if (!newest[r.tool] || String(r.ts) > String(newest[r.tool].ts)) newest[r.tool] = r;
        }
        const entries = await Promise.all(
          Object.entries(newest).map(async ([tool, meta]) => {
            try {
              const full = await api.run(meta.runId);
              return [tool, { result: norm(full), ts: meta.ts, target: meta.target }];
            } catch {
              return [tool, null];   // one bad run must not blank every card
            }
          })
        );
        if (!dead) setState({ loading: false, byTool: Object.fromEntries(entries.filter(([, v]) => v)) });
      } catch {
        if (!dead) setState({ loading: false, byTool: {} });
      }
    })();
    return () => { dead = true; };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  return state;
}

// Relative age of a stored result, so a card never implies it's live.
export function ago(ts) {
  const ms = Date.now() - new Date(ts).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '';
  const h = Math.floor(ms / 3600000);
  if (h < 1) return 'just now';
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return d === 1 ? 'yesterday' : `${d}d ago`;
}
