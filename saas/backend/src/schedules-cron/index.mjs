// ─────────────────────────────────────────────────────────────────────────
// SCHEDULES CRON — fires user-defined recurring tool runs (hourly tick).
//
// Each hour:
//   1. scan enabled schedules whose nextRunAt is due
//   2. advance nextRunAt (compare-and-swap claim → no double fire across ticks)
//   3. read the user fresh (tier / credits may have changed)
//   4. if they can't afford the run → record a skip + notify; else
//   5. Event-invoke the METERING gateway with a synthetic authenticated
//      /run/{toolId} event tagged with _scheduleId.
//
// The run itself flows through the one canonical gateway path — billing,
// history (tagged with scheduleId for period comparison), the "✅ finished"
// notification, and stamping the outcome back onto the schedule all happen
// there, exactly as if the user had clicked Run. This cron only decides WHEN.
// ─────────────────────────────────────────────────────────────────────────
import {
  scanDueSchedules, claimScheduleRun, recordScheduleRun,
  getUser, totalCredits, updateSchedule, addNotification,
} from '../lib/dynamo.mjs';
import { nextRunAt } from '../../../shared/schedule.mjs';
import { TOOLS, CREDIT_COSTS, isSchedulable } from '../../../shared/catalog.mjs';
import { accountBlocked } from '../lib/admin.mjs';

const METERING_FN = process.env.METERING_FN;

let _lambda = null;
async function invokeMetering(payload) {
  const { LambdaClient, InvokeCommand } = await import('@aws-sdk/client-lambda');
  _lambda ||= new LambdaClient({});
  await _lambda.send(new InvokeCommand({
    FunctionName: METERING_FN,
    InvocationType: 'Event', // fire-and-forget; the run reports its own outcome
    Payload: Buffer.from(JSON.stringify(payload)),
  }));
}

/** Split a comma/newline field into items (mirrors the gateway's fan-out split)
 *  so the credit precheck of a fan-out tool matches what it will actually cost. */
function splitCount(v) {
  if (!v) return 1;
  const items = String(v).split(/[\n,]+/).map((s) => s.trim()).filter(Boolean);
  return Math.max(1, Math.min(50, items.length));
}

/** Estimated credit cost of one fire of this schedule (unit × fan-out count). */
function estimateCost(tool, inputs) {
  const unit = CREDIT_COSTS[tool.cost] ?? 0;
  if (!unit) return 0;
  return tool.fanout ? unit * splitCount(inputs?.[tool.fanout]) : unit;
}

export const handler = async () => {
  const now = Date.now();
  const due = await scanDueSchedules(now);
  let fired = 0, skipped = 0, disabled = 0;

  for (const s of due) {
    const tool = TOOLS.find((t) => t.id === s.toolId);
    // A tool that vanished from the catalog (or lost schedulability) — disable so
    // it stops re-scanning every tick.
    if (!tool || !isSchedulable(tool)) {
      await updateSchedule(s.userId, s.scheduleId, { enabled: false }).catch(() => {});
      disabled++;
      continue;
    }

    // Advance to the next occurrence FROM NOW (not from the old nextRunAt) so a
    // missed window never triggers a burst of catch-up runs.
    const next = nextRunAt(s, now);
    const won = await claimScheduleRun(s.userId, s.scheduleId, s.nextRunAt, next).catch(() => false);
    if (!won) continue; // another tick already claimed this one

    const user = await getUser(s.userId).catch(() => null);
    if (!user) { await updateSchedule(s.userId, s.scheduleId, { enabled: false }).catch(() => {}); disabled++; continue; }
    if (accountBlocked(user)) { skipped++; continue; } // suspended — silently hold

    // Credit precheck — the gateway would 402 anyway (and never save the run), so
    // catch it here to record an honest "skipped" + nudge the user to top up.
    const cost = estimateCost(tool, s.inputs);
    if (cost > 0 && totalCredits(user) < cost) {
      await recordScheduleRun(s.userId, s.scheduleId, { runId: null, status: 'skipped_no_credits' }).catch(() => {});
      await addNotification({
        userId: s.userId,
        title: `⏸️ Scheduled ${tool.name} skipped`,
        body: `Not enough credits (${cost} needed). Top up to resume this schedule.`,
        link: '/schedules',
      }).catch(() => {});
      skipped++;
      continue;
    }

    const synthetic = {
      rawPath: `/run/${tool.id}`,
      requestContext: { http: { method: 'POST' }, authorizer: { lambda: { userId: user.userId, email: user.email, tier: user.tier } } },
      headers: {},
      body: JSON.stringify({
        ...(s.inputs || {}),
        ...(s.projectId ? { projectId: s.projectId } : {}),
        _scheduleId: s.scheduleId,
      }),
    };
    try {
      await invokeMetering(synthetic);
      fired++;
    } catch (e) {
      // Couldn't even dispatch — record a failure so the user isn't left thinking
      // it ran. The run will retry on the next due window.
      console.error('schedule_dispatch_failed', s.scheduleId, e.message);
      await recordScheduleRun(s.userId, s.scheduleId, { runId: null, status: 'failed' }).catch(() => {});
      skipped++;
    }
  }

  console.log(JSON.stringify({ metric: 'schedules_cron', due: due.length, fired, skipped, disabled }));
  return { due: due.length, fired, skipped, disabled };
};
