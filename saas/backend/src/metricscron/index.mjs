// Scheduled job (EventBridge, daily): re-pull the FREE Google integrations
// (Search Console / GA4 / Ads) for every project that already tracks them, and
// append a fresh performance snapshot — so the Performance charts build a
// continuous daily series without the user re-opening each tool.
//
// Only integration metrics are re-pulled here: they cost 0 credits and run
// server-side. Paid tools (audits, backlinks, AI visibility) are NOT re-run on a
// schedule — they snapshot only when the user runs them (metering gateway).
//
// Replays the stored run inputs (property + date range) against the user's saved
// connection. Connections that only carry a short-lived browser access token
// (no server refresh token) will fail to refresh here — that's expected; those
// series still update whenever the user opens the tool.
import { scanMetrics, getUser, appendMetricSnapshots } from '../lib/dynamo.mjs';
import { fetchIntegration } from '../lib/google.mjs';
import { extractMetrics, CRON_METRIC_TOOLS } from '../../../shared/metrics.mjs';

export const handler = async () => {
  const all = await scanMetrics();

  // One pull per (user, project, integration) — many metric rows share inputs.
  const jobs = new Map();
  for (const m of all) {
    if (!CRON_METRIC_TOOLS.includes(m.tool)) continue;
    const key = `${m.userId}#${m.projectId}#${m.tool}`;
    if (!jobs.has(key)) jobs.set(key, { userId: m.userId, projectId: m.projectId, tool: m.tool, toolName: m.toolName, target: m.target, inputs: m.inputs || {} });
  }

  const userCache = new Map();
  const loadUser = async (id) => {
    if (!userCache.has(id)) userCache.set(id, await getUser(id).catch(() => null));
    return userCache.get(id);
  };

  let pulled = 0, skipped = 0;
  for (const job of jobs.values()) {
    try {
      const user = await loadUser(job.userId);
      const conn = user?.integrations?.[job.tool];
      if (!conn?.connected) { skipped++; continue; }
      // Force a clean, comparison-free pull on the stored range/property.
      const body = { ...job.inputs, compare: 'None', input: job.inputs.input || conn.account };
      const live = await fetchIntegration(job.tool, conn, body);
      const metrics = extractMetrics(job.tool, { summary: live?.summary });
      if (!metrics.length) { skipped++; continue; }
      await appendMetricSnapshots(job.userId, { projectId: job.projectId, tool: job.tool, toolName: job.toolName, target: job.target, inputs: job.inputs }, metrics);
      pulled++;
    } catch (e) { console.error('metric_cron_failed', `${job.userId}#${job.projectId}#${job.tool}`, e.message); skipped++; }
  }

  console.log(JSON.stringify({ metric: 'metric_cron_run', jobs: jobs.size, pulled, skipped }));
  return { jobs: jobs.size, pulled, skipped };
};
