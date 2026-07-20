import { PLANS, TOPUP_PACKS, CURRENCY } from '@shared/catalog.mjs';
import { api } from '../lib/api.js';
import { useState } from 'react';
import { Unlock, Zap, Check } from 'lucide-react';

// Shown when the backend returns 403 (tier_locked) or 402 (insufficient_credits).
// On 402 we LEAD with one-time credit top-ups (instant, and they roll over) and
// offer a plan upgrade as the secondary path; on 403 it's an upgrade-only unlock
// prompt. Both buttons redirect to Stripe Checkout (or the mock success redirect).
export default function UpgradeModal({ reason, requiredTier, creditsRemaining, creditsNeeded, onClose }) {
  const outOfCredits = reason === 'insufficient_credits';
  const plan = PLANS[requiredTier || 'pro'];
  const [busy, setBusy] = useState(null); // 'upgrade' | a pack id | null

  async function upgrade() {
    setBusy('upgrade');
    try {
      const { url } = await api.checkout(plan.id, 'monthly');
      window.location.href = url; // Stripe Checkout (or mock success redirect)
    } finally {
      setBusy(null);
    }
  }

  async function buyTopup(packId) {
    setBusy(packId);
    try {
      const { url } = await api.topup(packId);
      window.location.href = url; // one-time Stripe payment → webhook grants credits
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-slate-900/50 p-4" onClick={onClose}>
      <div className="card w-full max-w-md p-6" onClick={(e) => e.stopPropagation()}>
        {outOfCredits ? (
          <>
            <Zap size={32} className="text-brand-600 dark:text-brand-400" aria-hidden />
            <h3 className="mt-2 text-xl font-bold">Out of credits</h3>
            <p className="mt-1 text-sm text-dim">
              {typeof creditsNeeded === 'number' && typeof creditsRemaining === 'number'
                ? `This run needs ${creditsNeeded} credits — you have ${creditsRemaining}. Top up to keep going; top-up credits roll over (valid 12 months).`
                : `You've used this month's credits. Top up now — top-up credits roll over (they don't expire at renewal; valid 12 months from purchase).`}
            </p>

            <div className="mt-4 grid gap-2 sm:grid-cols-3">
              {TOPUP_PACKS.map((pack) => (
                <button
                  key={pack.id}
                  onClick={() => buyTopup(pack.id)}
                  disabled={!!busy}
                  className={`rounded-lg border p-3 text-center transition hover:border-brand-400 disabled:opacity-50 ${
                    pack.popular ? 'border-brand-400 bg-brand-50 dark:bg-brand-500/10' : 'border-line'
                  }`}
                >
                  <div className="text-base font-bold leading-none">{pack.credits.toLocaleString()}</div>
                  <div className="text-[11px] text-muted">credits</div>
                  <div className="mt-1.5 text-xs font-semibold text-brand-700 dark:text-brand-300">
                    {busy === pack.id ? '…' : `${CURRENCY.symbol}${pack.price}`}
                  </div>
                </button>
              ))}
            </div>

            <div className="mt-5 flex items-center justify-between gap-3 border-t border-hair pt-4">
              <p className="text-xs text-muted">
                Need more every month? Upgrade to {plan.name} for {plan.monthlyCredits.toLocaleString()} credits/mo.
              </p>
              <div className="flex shrink-0 gap-2">
                <button className="btn-ghost" onClick={onClose} disabled={!!busy}>Not now</button>
                <button className="btn-primary whitespace-nowrap" onClick={upgrade} disabled={!!busy}>
                  {busy === 'upgrade' ? '…' : 'Upgrade'}
                </button>
              </div>
            </div>
          </>
        ) : (
          <>
            <Unlock size={32} className="text-brand-600 dark:text-brand-400" aria-hidden />
            <h3 className="mt-2 text-xl font-bold">Unlock with {plan.name}</h3>
            <p className="mt-1 text-sm text-dim">This tool is part of the {plan.name} plan.</p>
            <ul className="mt-4 space-y-1.5 text-sm">
              {plan.highlights.map((h) => (
                <li key={h} className="flex items-center gap-2">
                  <Check size={16} className="shrink-0 text-brand-600 dark:text-brand-400" aria-hidden />
                  {h}
                </li>
              ))}
            </ul>
            <div className="mt-6 flex items-center justify-between">
              <div>
                <span className="text-2xl font-bold">{CURRENCY.symbol}{plan.priceMonthly}</span>
                <span className="text-sm text-muted">/mo</span>
              </div>
              <div className="flex gap-2">
                <button className="btn-ghost" onClick={onClose}>Not now</button>
                <button className="btn-primary" onClick={upgrade} disabled={!!busy}>
                  {busy === 'upgrade' ? 'Redirecting…' : `Upgrade to ${plan.name}`}
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
