import { useState } from 'react';
import { TOPUP_PACKS, CURRENCY } from '@shared/catalog.mjs';
import { api } from '../lib/api.js';
import { toast } from '../lib/ui.js';

/* One-time credit top-ups. Lived only on /account (below the invoice list, so
   effectively invisible) — people who ran low on the Credits & usage or Pricing
   page had no way to buy from where they noticed the problem. Shared here so
   every page that talks about credits can offer the purchase. */
export default function TopupPacks({ title = 'Need more credits?', className = 'card mt-4 p-5' }) {
  const [busy, setBusy] = useState(null);

  async function buy(packId) {
    setBusy(packId);
    try {
      const { url } = await api.topup(packId);
      window.location.href = url;
    } catch (e) {
      toast(e?.message || 'Could not start checkout.', 'error');
      setBusy(null);
    }
  }

  return (
    <div className={className}>
      <h2 className="font-bold">{title}</h2>
      <p className="mt-1 text-sm text-muted">
        One-time top-ups for when you run low mid-cycle. Top-up credits <strong>roll over</strong> — they don't expire at renewal, and stay valid for 12 months from purchase.
      </p>
      <div className="mt-4 grid gap-3 sm:grid-cols-3">
        {TOPUP_PACKS.map((pack) => (
          <div key={pack.id} className={`rounded-lg border p-4 text-center ${pack.popular ? 'border-brand-400 bg-brand-50 dark:bg-brand-500/10' : 'border-line'}`}>
            {pack.popular && <span className="mb-1 inline-block rounded-full bg-brand-600 px-2 py-0.5 text-[10px] font-bold text-white">BEST VALUE</span>}
            <p className="text-lg font-bold">{pack.credits.toLocaleString()} credits</p>
            <p className="text-sm text-muted">{CURRENCY.symbol}{pack.price}</p>
            <button onClick={() => buy(pack.id)} disabled={busy === pack.id} className="btn-ghost mt-3 w-full">
              {busy === pack.id ? '…' : 'Buy credits'}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
