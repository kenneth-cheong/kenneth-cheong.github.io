import { PLANS, CURRENCY } from '@shared/catalog.mjs';
import { api } from '../lib/api.js';
import { useState } from 'react';
import { Unlock, Check } from 'lucide-react';

// Shown when the backend returns 403 (tier_locked) or 402 (insufficient_credits).
export default function UpgradeModal({ reason, requiredTier, onClose }) {
  const [busy, setBusy] = useState(false);
  const plan = PLANS[requiredTier || 'pro'];

  async function upgrade() {
    setBusy(true);
    try {
      const { url } = await api.checkout(plan.id, 'monthly');
      window.location.href = url; // Stripe Checkout (or mock success redirect)
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-slate-900/50 p-4" onClick={onClose}>
      <div className="card w-full max-w-md p-6" onClick={(e) => e.stopPropagation()}>
        <Unlock size={32} className="text-brand-600" aria-hidden />
        <h3 className="mt-2 text-xl font-bold">
          {reason === 'insufficient_credits' ? 'Out of credits' : `Unlock with ${plan.name}`}
        </h3>
        <p className="mt-1 text-sm text-slate-600">
          {reason === 'insufficient_credits'
            ? `You've used this month's credits. Upgrade for more, or top up.`
            : `This tool is part of the ${plan.name} plan.`}
        </p>
        <ul className="mt-4 space-y-1.5 text-sm">
          {plan.highlights.map((h) => (
            <li key={h} className="flex items-center gap-2">
              <Check size={16} className="shrink-0 text-brand-600" aria-hidden />
              {h}
            </li>
          ))}
        </ul>
        <div className="mt-6 flex items-center justify-between">
          <div>
            <span className="text-2xl font-bold">{CURRENCY.symbol}{plan.priceMonthly}</span>
            <span className="text-sm text-slate-500">/mo</span>
          </div>
          <div className="flex gap-2">
            <button className="btn-ghost" onClick={onClose}>Not now</button>
            <button className="btn-primary" onClick={upgrade} disabled={busy}>
              {busy ? 'Redirecting…' : `Upgrade to ${plan.name}`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
