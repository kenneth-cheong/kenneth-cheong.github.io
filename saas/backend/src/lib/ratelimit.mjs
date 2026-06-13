// ─────────────────────────────────────────────────────────────────────────
// Application-layer rate limiting (fixed-window counters in DynamoDB).
//
// Backs onto the existing Cache table (TTL on `expireAt` self-sweeps old
// windows). Each call atomically increments a per-(scope,id,window) counter and
// reports whether the caller is over the limit. Multiple windows can be checked
// at once (e.g. a generous per-minute burst + a per-hour ceiling).
//
// This complements the API Gateway stage throttle (edge, IP-agnostic, absorbs
// volumetric floods) by enforcing a PER-USER / PER-IP budget — and crucially it
// runs inside the handler, so it also covers the metering Function-URL path that
// bypasses API Gateway entirely.
//
// Fails OPEN: if the counter write errors we allow the request. A limiter must
// never be the thing that takes the product down.
// ─────────────────────────────────────────────────────────────────────────
import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from './dynamo.mjs';

const TABLE = process.env.CACHE_TABLE;

/**
 * @param {string} scope  logical bucket, e.g. 'run' | 'auth' | 'app'
 * @param {string} id     the subject — userId or source IP
 * @param {{n:number, seconds:number}[]} windows  limits to enforce (all must pass)
 * @returns {Promise<{allowed:boolean, retryAfter?:number, limit?:number}>}
 */
export async function rateLimit(scope, id, windows) {
  if (!TABLE || !id) return { allowed: true }; // misconfigured → don't block
  const now = Math.floor(Date.now() / 1000);
  for (const w of windows) {
    const windowStart = Math.floor(now / w.seconds) * w.seconds;
    const key = `rl#${scope}#${id}#${w.seconds}#${windowStart}`;
    let count;
    try {
      const res = await ddb.send(new UpdateCommand({
        TableName: TABLE,
        Key: { key },
        // ADD creates the attribute at 0 then increments; expireAt is set once so
        // DynamoDB TTL reaps the row shortly after the window closes.
        UpdateExpression: 'ADD #c :one SET expireAt = if_not_exists(expireAt, :exp)',
        ExpressionAttributeNames: { '#c': 'count' },
        ExpressionAttributeValues: { ':one': 1, ':exp': windowStart + w.seconds + 10 },
        ReturnValues: 'UPDATED_NEW',
      }));
      count = res.Attributes?.count ?? 1;
    } catch (e) {
      console.error('ratelimit_error', scope, e.message); // fail open
      return { allowed: true };
    }
    if (count > w.n) {
      return { allowed: false, retryAfter: windowStart + w.seconds - now, limit: w.n };
    }
  }
  return { allowed: true };
}

// ── Generous default budgets (tuned to never bother real users) ──────────────
// Tool runs are the billable/expensive path; auth is the brute-force path.
export const RUN_LIMITS = [{ n: 90, seconds: 60 }, { n: 1500, seconds: 3600 }];
export const AUTH_LIMITS = [{ n: 30, seconds: 60 }, { n: 200, seconds: 3600 }];
export const APP_LIMITS = [{ n: 300, seconds: 60 }, { n: 4000, seconds: 3600 }];
