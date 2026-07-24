// Background-job tools — the client half of the async run protocol.
//
// Some tools take minutes (the Content Optimiser's 10–30 LLM calls, the
// Technical SEO crawler's multi-page crawl). Those don't answer the run request
// directly: they persist a job, self-invoke a server-side finalizer and return
// `{ jobId, status }` immediately. The run then finishes on our servers whether
// or not this tab survives, and the browser's only job is to poll `status` until
// it lands — picking up real stage/progress and partial results on the way.
//
// This lives here rather than in ToolRunner because it has two callers: the tool
// page and the Site Health Check, which fans out to several tools at once and
// would otherwise treat "here's your job id" as the finished result.

import { api } from './api.js';

/** Is this run response a job handle rather than a result? */
export function isJobStart(result) {
  return !!(result && result.jobId && result.status && !result.sections && !result.html && !result.rows);
}

/**
 * Poll a background job until it finishes.
 *
 * Transient poll failures are ignored — the job keeps running server-side. A
 * hard cap stops a zombie poll loop; the run itself still completes, lands in
 * History and fires a notification.
 *
 * @param {string}   toolId
 * @param {string}   jobId
 * @param {Function} [onTick] called with each `running` job snapshot
 * @returns {Promise<object>} the finished job ({ result, runId, credits… })
 */
export async function pollJob(toolId, jobId, onTick) {
  // Must outlast the server's own deadline (MeteringFn's 900s timeout, minus
  // the finalizer's 20s self-deadline margin) — otherwise we give up first and
  // report a failure for a run that was about to report success.
  const deadline = Date.now() + 16 * 60 * 1000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3500));
    let s = null;
    try { s = (await api.runTool(toolId, { cwAction: 'status', jobId }, true))?.result; }
    catch { continue; }
    if (!s) continue;
    if (s.status === 'done') return s;
    if (s.status === 'error') throw new Error(s.error || 'The run failed. No credits were charged.');
    if (s.status === 'unknown') throw new Error('We lost track of this run — check History in a minute; it may still have finished.');
    onTick?.(s);
  }
  throw new Error('This is taking unusually long. The run continues in the background — you’ll get a notification, and the result will be in History.');
}

/**
 * Run a tool and, if it answers with a job handle, see the job through to its
 * result — so callers can treat async and synchronous tools identically.
 * Returns the same `{ result, runId, creditsRemaining, … }` shape either way.
 */
export async function runToolToCompletion(toolId, input, slow, onTick) {
  const res = await api.runTool(toolId, input, slow);
  if (!isJobStart(res?.result)) return res;
  onTick?.({ status: res.result.status });
  const done = await pollJob(toolId, res.result.jobId, onTick);
  return {
    result: done.result || {},
    runId: done.runId || null,
    creditsUsed: done.creditsUsed,
    creditsRemaining: done.creditsRemaining,
    topupRemaining: done.topupRemaining,
  };
}
