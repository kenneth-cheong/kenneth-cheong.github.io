#!/usr/bin/env node
// One-shot: compute `lifetimePaidCents` for every user who has a Stripe
// customer, so Admin → Users shows historical revenue and not just what the
// webhook has booked since the counter shipped.
//
//   USERS_TABLE=digimetrics-saas-UsersTable-XXXX AWS_REGION=ap-southeast-1 \
//     STRIPE_SECRET_KEY=sk_live_… node scripts/backfill-lifetime-paid.mjs
//
// Add --dry-run to print the figures without writing.
//
// Definition matches the webhook exactly (billing/index.mjs):
//   + paid invoices (subscriptions, including prorations)
//   + succeeded charges with NO invoice (one-time top-ups)
//   − refunds on either
// Overwrites rather than adds, so it is safe to re-run at any time: the total
// is always recomputed from Stripe, never accumulated on top of what's there.
//
// NOTE: this reads the CURRENT Stripe account only. After the 2026-07 migration
// to acct_1TvqoaBJVcT2xr6l, charges made on the old account are not visible
// here and will not be counted.
import Stripe from 'stripe';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';

const TABLE = process.env.USERS_TABLE;
const KEY = process.env.STRIPE_SECRET_KEY;
if (!TABLE || !KEY) { console.error('Set USERS_TABLE, STRIPE_SECRET_KEY (and AWS_REGION).'); process.exit(1); }
const DRY = process.argv.includes('--dry-run');

const stripe = new Stripe(KEY);
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

// Everything a single customer has ever paid us, net of refunds, in cents.
async function paidByCustomer(customerId) {
  let cents = 0, currency = 'usd';

  for await (const inv of stripe.invoices.list({ customer: customerId, status: 'paid', limit: 100 })) {
    cents += inv.amount_paid || 0;
    if (inv.currency) currency = inv.currency;
  }

  // Charges cover both the top-ups (no invoice) and the refunds on everything.
  for await (const ch of stripe.charges.list({ customer: customerId, limit: 100 })) {
    if (ch.status === 'succeeded' && ch.paid && !ch.invoice) {
      cents += ch.amount || 0;
      if (ch.currency) currency = ch.currency;
    }
    cents -= ch.amount_refunded || 0;
  }

  return { cents, currency };
}

let scanned = 0, priced = 0, ExclusiveStartKey;
do {
  const res = await ddb.send(new ScanCommand({ TableName: TABLE, ExclusiveStartKey }));
  for (const u of res.Items || []) {
    scanned++;
    if (!u.stripeCustomerId) continue;
    let total;
    try {
      total = await paidByCustomer(u.stripeCustomerId);
    } catch (e) {
      // A customer id left over from the account migration resolves nowhere.
      // Report and move on — one dead id must not abort the whole backfill.
      console.error(`  ! ${u.userId} (${u.stripeCustomerId}): ${e.message}`);
      continue;
    }
    console.log(`  ${u.email || u.userId} -> ${(total.cents / 100).toFixed(2)} ${total.currency.toUpperCase()}`);
    if (!DRY) {
      await ddb.send(new UpdateCommand({
        TableName: TABLE,
        Key: { userId: u.userId },
        UpdateExpression: 'SET lifetimePaidCents = :c, lifetimePaidCurrency = :ccy',
        ExpressionAttributeValues: { ':c': total.cents, ':ccy': total.currency },
      }));
    }
    priced++;
  }
  ExclusiveStartKey = res.LastEvaluatedKey;
} while (ExclusiveStartKey);

console.log(`✅ ${DRY ? 'dry run' : 'backfill'} complete — scanned ${scanned}, priced ${priced}`);
