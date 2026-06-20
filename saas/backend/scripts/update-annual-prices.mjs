#!/usr/bin/env node
// Targeted re-price of the ANNUAL Stripe prices to match catalog.mjs (currently
// 20% off = 9.6× monthly), WITHOUT the duplicate products/top-ups that re-running
// setup-stripe.mjs would create.
//
// For each paid tier it: reads the current annual Price ID from SSM, finds its
// product, creates a NEW annual price at the catalog amount on that same product,
// archives the old annual price, and writes the new Price ID back to SSM.
// Monthly prices, products and top-up packs are left untouched. Existing
// subscribers keep their current price until they renew/re-checkout.
//
//   AWS_REGION=ap-southeast-1 node scripts/update-annual-prices.mjs
//
// The Stripe secret is pulled from Secrets Manager at runtime (never an arg/env
// you have to paste), so it never lands in your shell history or logs.
import { execFileSync } from 'node:child_process';
import Stripe from 'stripe';
import { SSMClient, GetParameterCommand, PutParameterCommand } from '@aws-sdk/client-ssm';
import { PLANS, CURRENCY } from '../../shared/catalog.mjs';

const REGION = process.env.AWS_REGION || 'ap-southeast-1';
const PAID = ['starter', 'pro', 'expert'];
const ANNUAL_MULTIPLIER = 12 * 0.8; // 12 months less 20%

// Pull the Stripe secret from Secrets Manager without printing it.
const stripeKey = execFileSync('aws', [
  'secretsmanager', 'get-secret-value',
  '--secret-id', 'digimetrics-saas/stripe-secret-key',
  '--region', REGION, '--query', 'SecretString', '--output', 'text',
], { encoding: 'utf8' }).trim();

const stripe = new Stripe(stripeKey);
const ssm = new SSMClient({ region: REGION });
const mode = stripeKey.startsWith('sk_live') ? 'LIVE' : 'TEST';
console.log(`▸ Stripe ${mode} mode · region ${REGION}\n`);

async function getParam(name) {
  const r = await ssm.send(new GetParameterCommand({ Name: name }));
  return r.Parameter.Value;
}
async function putParam(name, value) {
  await ssm.send(new PutParameterCommand({ Name: name, Value: value, Type: 'String', Overwrite: true }));
}

for (const id of PAID) {
  const plan = PLANS[id];
  const newAmount = Math.round(plan.priceMonthly * ANNUAL_MULTIPLIER * 100); // cents
  const ssmName = `/saas/price/${id}/annual`;

  const oldId = await getParam(ssmName);
  const oldPrice = await stripe.prices.retrieve(oldId);
  const productId = typeof oldPrice.product === 'string' ? oldPrice.product : oldPrice.product.id;

  if (oldPrice.unit_amount === newAmount) {
    console.log(`= ${plan.name}: annual already ${CURRENCY.symbol}${newAmount / 100} (${oldId}) — skipped`);
    continue;
  }

  const newPrice = await stripe.prices.create({
    product: productId,
    currency: CURRENCY.code.toLowerCase(),
    unit_amount: newAmount,
    recurring: { interval: 'year' },
    metadata: { tier: id, interval: 'annual' },
  });
  await stripe.prices.update(oldId, { active: false });
  await putParam(ssmName, newPrice.id);

  console.log(
    `✓ ${plan.name}: annual ${CURRENCY.symbol}${oldPrice.unit_amount / 100} → ${CURRENCY.symbol}${newAmount / 100}` +
    `  (${CURRENCY.symbol}${Math.round(plan.priceMonthly * 0.8)}/mo equiv)\n` +
    `    new ${newPrice.id} · archived ${oldId} · ssm ${ssmName}`
  );
}

console.log('\n✅ Annual prices updated. Redeploy the backend so the new Price IDs reach the Lambda env.');
