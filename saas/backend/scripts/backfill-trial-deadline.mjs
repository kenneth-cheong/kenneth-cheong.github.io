#!/usr/bin/env node
// One-shot, RUN BEFORE (or immediately with) the deploy that turns Free into a
// 7-day trial. Sets `freeAccessEndsAt` on every existing Free account.
//
//   USERS_TABLE=digimetrics-saas-UsersTable-XXXX AWS_REGION=ap-southeast-1 \
//     node scripts/backfill-trial-deadline.mjs --days 14
//
// Add --dry-run to see the counts without writing.
//
// WHY THIS EXISTS
// The access gate (src/lib/access.mjs) falls back to `createdAt + 7 days` when
// no explicit deadline is stored. Every Free account that predates the feature
// signed up more than 7 days ago, so the moment the gate goes live they are ALL
// locked out at once — with no warning email, because the warning job needs a
// window that hasn't closed yet to warn about.
//
// This writes an explicit deadline `--days` from now, which gives existing free
// users a real runway and lets the daily job warn them at 3 days and 1 day like
// anyone else. Pick a number you'd be comfortable seeing in a support ticket;
// 14 is the default for that reason.
//
// Nobody's data is touched here in either direction — this only moves the date
// their access is checked against. Idempotent: re-running resets the same
// deadline to `--days` from the new now, so don't re-run casually after launch.
// Accounts that already carry a deadline are skipped unless --force.
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';

const TABLE = process.env.USERS_TABLE;
if (!TABLE) { console.error('Set USERS_TABLE (and AWS_REGION).'); process.exit(1); }
const DRY = process.argv.includes('--dry-run');
const FORCE = process.argv.includes('--force');
const daysArg = process.argv.indexOf('--days');
const DAYS = daysArg > -1 ? parseInt(process.argv[daysArg + 1], 10) : 14;
if (!Number.isInteger(DAYS) || DAYS < 0 || DAYS > 365) { console.error('--days must be 0–365.'); process.exit(1); }

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const endsAt = new Date(Date.now() + DAYS * 86_400_000).toISOString();

let scanned = 0, set = 0, skippedPaid = 0, skippedExisting = 0;
let ExclusiveStartKey;
do {
  const page = await ddb.send(new ScanCommand({ TableName: TABLE, ExclusiveStartKey }));
  for (const u of page.Items || []) {
    // Provisioned-but-unlinked invites aren't accounts yet; they get their
    // deadline when they first sign in.
    if (!u.userId || String(u.userId).startsWith('pending:')) continue;
    scanned++;
    if ((u.tier || 'free') !== 'free') { skippedPaid++; continue; }
    if (u.freeAccessEndsAt && !FORCE) { skippedExisting++; continue; }
    if (!DRY) {
      await ddb.send(new UpdateCommand({
        TableName: TABLE, Key: { userId: u.userId },
        UpdateExpression: 'SET freeAccessEndsAt = :e, updatedAt = :now',
        ExpressionAttributeValues: { ':e': endsAt, ':now': new Date().toISOString() },
      }));
    }
    set++;
  }
  ExclusiveStartKey = page.LastEvaluatedKey;
} while (ExclusiveStartKey);

console.log(JSON.stringify({
  dryRun: DRY, days: DAYS, endsAt,
  scanned, freeAccountsSet: set, skippedPaid, skippedAlreadyHadDeadline: skippedExisting,
}, null, 2));
