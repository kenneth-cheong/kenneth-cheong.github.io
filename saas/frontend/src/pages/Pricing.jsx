import { useState } from 'react';
import { Check } from 'lucide-react';
import { PLANS, tierRank, CURRENCY } from '@shared/catalog.mjs';
import { useAuth } from '../context/AuthContext.jsx';
import { api } from '../lib/api.js';
import { toast, confirmDialog } from '../lib/ui.js';
import TopupPacks from '../components/TopupPacks.jsx';

const ORDER = ['free', 'starter', 'pro', 'expert'];

export default function Pricing() {
  const { user, refresh } = useAuth();
  const [interval, setInterval] = useState('monthly');
  const [busy, setBusy] = useState(null);
  // A code entered here is checked against the plan the user is actually
  // looking at, so `promo` is cleared whenever the interval changes — a code
  // valid on monthly isn't necessarily valid on annual.
  const [code, setCode] = useState('');
  const [promo, setPromo] = useState(null);      // { percentOff, amountOff, ... }
  const [promoErr, setPromoErr] = useState('');
  const [checking, setChecking] = useState(false);

  function setBilling(iv) {
    setInterval(iv);
    setPromo(null);
    setPromoErr('');
  }

  // Validated against the most expensive plan we can price it on so the buyer
  // gets a straight yes/no before picking a tier; the real discount is applied
  // per-plan server-side at checkout.
  async function applyCode(e) {
    e?.preventDefault();
    const entered = code.trim().toUpperCase();
    if (!entered) return;
    setChecking(true); setPromoErr('');
    try {
      const res = await api.validatePromo(entered, 'pro', interval);
      if (res.valid) { setPromo(res); setPromoErr(''); }
      else { setPromo(null); setPromoErr(res.error || 'That code isn’t valid.'); }
    } catch (err) {
      setPromo(null);
      setPromoErr(err.message);
    } finally {
      setChecking(false);
    }
  }

  // Downgrading to Free means cancelling the paid subscription — there's no
  // "Free subscription" to switch into. We cancel at period end so they keep
  // what they've already paid for and simply lapse to Free when it runs out.
  async function downgradeToFree() {
    if (!user.hasSubscription) return; // nothing to cancel — already on Free
    const ok = await confirmDialog({
      title: 'Downgrade to Free',
      message: `Cancel your ${PLANS[user.tier].name} plan? You'll keep it until the end of your current billing period, then move to the Free plan. Any credits you've already bought stay valid.`,
      confirmText: 'Downgrade to Free',
      cancelText: 'Keep my plan',
      danger: true,
    });
    if (!ok) return;
    setBusy('free');
    try {
      await api.cancelPlan(true); // at period end — they keep what they paid for
      toast('Downgrading to Free — you keep your current plan until the end of the billing period.', 'success');
      await refresh();
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      setBusy(null);
    }
  }

  async function choose(tier) {
    if (tier === user.tier && !promo) return;
    if (tier === 'free') return downgradeToFree();
    setBusy(tier);
    const applied = promo ? code.trim().toUpperCase() : undefined;
    try {
      // Already subscribed → switch the existing subscription in place so Stripe
      // prorates. Sending them through checkout again would open a SECOND
      // subscription and bill them twice. This path never opens Checkout, so the
      // code has to ride along on the request — there's no Stripe page to type
      // it into.
      if (user.hasSubscription) {
        const res = await api.changePlan(tier, interval, applied);
        // Say what actually happens to their money. On a trial nothing is
        // prorated — there's no charge yet to prorate against — so the old
        // blanket "your next invoice is prorated" promised a bill that never
        // arrives and buried the one fact that matters: the plan is live now.
        const when = res.effectiveAt
          ? new Date(res.effectiveAt * 1000).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
          : null;
        const billing = res.trialing
          ? `Your trial continues${when ? ` — first invoice on ${when}` : ''}.`
          : 'Your next invoice is prorated.';
        toast(
          `${PLANS[tier].name} is active${res.discounted ? ` with ${applied} applied` : ''}. ${billing}`,
          'success',
        );
        await refresh();
        return;
      }
      const { url } = await api.checkout(tier, interval, applied);
      window.location.href = url;
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      setBusy(null);
    }
  }

  // What the card should show once a code is in play. Percentage discounts price
  // every tier; a fixed amount off is shown as-is.
  function discounted(price) {
    if (!promo) return null;
    const off = promo.percentOff != null
      ? price * (promo.percentOff / 100)
      : (promo.amountOff || 0) / 100;
    return Math.max(0, Math.round((price - off) * 100) / 100);
  }

  const promoLabel = !promo ? '' :
    `${promo.percentOff != null ? `${promo.percentOff}% off` : `${CURRENCY.symbol}${(promo.amountOff / 100).toFixed(2)} off`}`
    + (promo.duration === 'repeating' ? ` for ${promo.durationInMonths} months`
      : promo.duration === 'forever' ? ', for as long as you subscribe'
      : ' on your first invoice')
    // A trial is the most valuable thing a code can carry, so say it out loud
    // rather than letting the buyer discover it on Stripe's page — or never.
    + (promo.trialDays ? `, after a ${promo.trialDays}-day free trial` : '');

  return (
    <div>
      <div className="text-center">
        <h1 className="text-3xl font-bold">Plans that scale with you</h1>
        <p className="mt-2 text-dim">
          Credits are the app’s currency — most tool runs cost 1–5. Your plan refills them monthly; top-ups roll over and stay valid for 12 months. Cancel anytime.
        </p>
        <div className="mt-5 inline-flex rounded-full bg-sunken p-1 text-sm font-medium">
          {['monthly', 'annual'].map((iv) => (
            <button
              key={iv}
              onClick={() => setBilling(iv)}
              className={`rounded-full px-4 py-1.5 capitalize ${interval === iv ? 'bg-surface shadow text-brand-700 dark:text-brand-300' : 'text-muted'}`}
            >
              {iv} {iv === 'annual' && <span className="text-green-600 dark:text-green-400">−20%</span>}
            </button>
          ))}
        </div>

        {/* Codes work at Stripe's own checkout too, but a subscriber switching
            plans never sees that page — and nobody should have to redirect to
            find out whether their code is real. */}
        <form onSubmit={applyCode} className="mt-4 flex items-start justify-center gap-2">
          <div>
            <label htmlFor="promo" className="sr-only">Promo code</label>
            <input
              id="promo"
              value={code}
              onChange={(e) => { setCode(e.target.value.toUpperCase()); setPromo(null); setPromoErr(''); }}
              placeholder="Promo code"
              autoComplete="off"
              spellCheck={false}
              className="field w-44 text-center uppercase tracking-wide"
            />
            {promoErr && <p className="mt-1 text-xs text-red-600 dark:text-red-400" role="alert">{promoErr}</p>}
            {promo && <p className="mt-1 text-xs font-medium text-green-600 dark:text-green-400">{promo.code} applied — {promoLabel}.</p>}
          </div>
          <button type="submit" disabled={!code.trim() || checking} className="btn-ghost disabled:opacity-60">
            {checking ? '…' : 'Apply'}
          </button>
        </form>
      </div>

      <div className="mt-8 grid gap-5 lg:grid-cols-4">
        {ORDER.map((id) => {
          const p = PLANS[id];
          const current = user.tier === id;
          const price = interval === 'annual' ? Math.round(p.priceMonthly * 0.8) : p.priceMonthly;
          return (
            <div key={id} className={`card flex flex-col p-5 ${current ? 'ring-2 ring-brand-500' : ''}`}>
              {/* The badge and the blurb both used to change the height of what
                  sits above the price, so the prices didn't line up across the
                  row. Reserve a badge slot on every card, and hold the blurb to
                  two lines, so every price starts at the same offset.
                  Where you already are beats where the crowd is: the ring and
                  badge mark the plan you're on, and MOST POPULAR only claims
                  the badge slot on a card you aren't already sitting on. */}
              <span
                aria-hidden={!current && !p.popular}
                className={`mb-2 w-fit rounded-full px-2 py-0.5 text-xs font-bold ${current ? 'bg-brand-600 text-white' : p.popular ? 'bg-slate-200 text-slate-700 dark:bg-slate-700 dark:text-slate-200' : 'invisible'}`}
              >
                {current ? 'YOUR PLAN' : 'MOST POPULAR'}
              </span>
              <h3 className="text-lg font-bold">{p.name}</h3>
              <p className="mt-1 min-h-[2.5rem] text-sm text-muted">{p.blurb}</p>
              <div className="mt-4">
                {promo && id !== 'free' ? (
                  <>
                    <span className="text-sm text-muted line-through">{CURRENCY.symbol}{price}</span>{' '}
                    <span className="text-3xl font-bold">{CURRENCY.symbol}{discounted(price)}</span>
                  </>
                ) : (
                  <span className="text-3xl font-bold">{CURRENCY.symbol}{price}</span>
                )}
                <span className="text-sm text-muted">/mo</span>
              </div>
              <ul className="mt-4 flex-1 space-y-2 text-sm">
                {p.highlights.map((h) => (
                  <li key={h} className="flex items-center gap-2"><Check size={15} className="shrink-0 text-brand-600 dark:text-brand-400" aria-hidden />{h}</li>
                ))}
              </ul>
              <button
                onClick={() => choose(id)}
                disabled={(current && !(promo && user.hasSubscription)) || busy === id}
                className={`mt-5 ${p.popular ? 'btn-primary' : 'btn-ghost'} w-full disabled:opacity-60`}
              >
                {/* With a code in hand, staying put is a real action — it applies
                    the discount to the plan they're already on. The Free card is
                    only reachable by a paying subscriber, so there it's a
                    downgrade — cancelling the current plan at period end. */}
                {current && promo && user.hasSubscription ? 'Apply to my plan'
                  : current ? 'Current plan' : busy === id ? '…'
                  : id === 'free' ? 'Downgrade to Free'
                  : tierRank(id) > tierRank(user.tier) ? `Upgrade to ${p.name}` : `Switch to ${p.name}`}
              </button>
            </div>
          );
        })}
      </div>

      {/* Not everyone comparing plans wants to change plan — some just need
          credits now. Offer that here rather than only on /account. */}
      <div className="mx-auto mt-8 max-w-3xl">
        <TopupPacks title="Just need more credits?" className="card p-5" />
      </div>
    </div>
  );
}
