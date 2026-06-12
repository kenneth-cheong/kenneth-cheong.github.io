#!/usr/bin/env node
// One-shot: create the SGD Stripe products + monthly/annual prices, then write
// each Price ID into SSM Parameter Store where template.yaml reads them.
//
//   STRIPE_SECRET_KEY=sk_test_xxx AWS_REGION=ap-southeast-1 node scripts/setup-stripe.mjs
//
// Idempotent-ish: re-running creates NEW prices (Stripe prices are immutable).
// Run once per environment (test, then live). Annual = 10× monthly (2 months free).
import Stripe from 'stripe';
import { SSMClient, PutParameterCommand } from '@aws-sdk/client-ssm';
import { PLANS, CURRENCY, TOPUP_PACKS } from '../../shared/catalog.mjs';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const ssm = new SSMClient({});
const PAID = ['starter', 'pro', 'expert'];

async function putParam(name, value) {
  await ssm.send(new PutParameterCommand({ Name: name, Value: value, Type: 'String', Overwrite: true }));
  console.log(`  ssm ${name} = ${value}`);
}

for (const id of PAID) {
  const plan = PLANS[id];
  const product = await stripe.products.create({
    name: `Digimetrics ${plan.name}`,
    description: plan.blurb,
    metadata: { tier: id },
  });

  const monthly = await stripe.prices.create({
    product: product.id,
    currency: CURRENCY.code.toLowerCase(), // sgd
    unit_amount: plan.priceMonthly * 100,
    recurring: { interval: 'month' },
    metadata: { tier: id, interval: 'monthly' },
  });

  const annual = await stripe.prices.create({
    product: product.id,
    currency: CURRENCY.code.toLowerCase(),
    unit_amount: plan.priceMonthly * 10 * 100, // 2 months free
    recurring: { interval: 'year' },
    metadata: { tier: id, interval: 'annual' },
  });

  console.log(`\n${plan.name}: ${CURRENCY.symbol}${plan.priceMonthly}/mo`);
  await putParam(`/saas/price/${id}/monthly`, monthly.id);
  await putParam(`/saas/price/${id}/annual`, annual.id);
}

// One-time top-up packs (mode: payment).
for (const pack of TOPUP_PACKS) {
  const product = await stripe.products.create({
    name: `Digimetrics ${pack.name} (${pack.credits} credits)`,
    metadata: { type: 'topup', packId: pack.id, credits: String(pack.credits) },
  });
  const price = await stripe.prices.create({
    product: product.id,
    currency: CURRENCY.code.toLowerCase(),
    unit_amount: pack.price * 100,
    metadata: { packId: pack.id, credits: String(pack.credits) },
  });
  console.log(`\nTop-up ${pack.name}: ${CURRENCY.symbol}${pack.price} → ${pack.credits} credits`);
  await putParam(`/saas/price/topup/${pack.id}`, price.id);
}

console.log('\n✅ Done. Now `sam deploy` to pick up the new SSM Price IDs.');
