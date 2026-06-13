import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { PartyPopper, Zap } from 'lucide-react';
import { PLANS, TOPUP_PACKS, CURRENCY } from '@shared/catalog.mjs';
import { useAuth } from '../context/AuthContext.jsx';
import { api } from '../lib/api.js';

export default function Account() {
  const { user, refresh } = useAuth();
  const [params] = useSearchParams();
  const [busy, setBusy] = useState(false);
  const [topupBusy, setTopupBusy] = useState(null);
  const plan = PLANS[user.tier];

  // Returning from Stripe Checkout / top-up → pull the fresh tier + credits.
  useEffect(() => {
    if (params.get('checkout') === 'success' || params.get('topup') === 'success') refresh();
  }, [params, refresh]);

  async function buyTopup(packId) {
    setTopupBusy(packId);
    try {
      const { url } = await api.topup(packId);
      window.location.href = url;
    } finally {
      setTopupBusy(null);
    }
  }

  async function openPortal() {
    setBusy(true);
    try {
      const { url } = await api.portal();
      window.location.href = url;
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="text-2xl font-bold">Account</h1>

      {params.get('checkout') === 'success' && (
        <div className="mt-4 flex items-center gap-2 rounded-lg bg-green-50 px-4 py-3 text-sm text-green-800">
          <PartyPopper size={16} aria-hidden /> You're on {plan.name}. Credits have been topped up.
        </div>
      )}
      {params.get('topup') === 'success' && (
        <div className="mt-4 flex items-center gap-2 rounded-lg bg-green-50 px-4 py-3 text-sm text-green-800">
          <Zap size={16} aria-hidden /> Top-up successful — credits added to your balance.
        </div>
      )}

      <div className="card mt-6 p-5">
        <div className="flex items-center gap-3">
          {user.picture && <img src={user.picture} alt="" className="h-10 w-10 rounded-full" />}
          <div>
            <p className="font-semibold">{user.name}</p>
            <p className="text-sm text-slate-500">{user.email}</p>
          </div>
        </div>
      </div>

      <div className="card mt-4 p-5">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm text-slate-500">Current plan</p>
            <p className="text-xl font-bold">{plan.name}</p>
          </div>
          <div className="text-right">
            <p className="text-sm text-slate-500">Credits left</p>
            <p className="text-xl font-bold">{user.credits.toLocaleString()}</p>
            <p className="text-xs text-slate-400">
              {(user.monthlyCredits ?? user.credits).toLocaleString()} monthly
              {(user.topupCredits || 0) > 0 && <> · {user.topupCredits.toLocaleString()} top-up</>}
            </p>
          </div>
        </div>
        <div className="mt-5 flex gap-3">
          <Link to="/pricing" className="btn-primary">Change plan</Link>
          {user.hasSubscription && (
            <button onClick={openPortal} disabled={busy} className="btn-ghost">
              {busy ? '…' : 'Manage billing'}
            </button>
          )}
        </div>
        {user.hasSubscription && (
          <p className="mt-3 text-xs text-slate-400">
            Manage billing opens the Stripe Customer Portal — update card, download invoices, or cancel.
          </p>
        )}
      </div>

      {/* ── Credit top-ups (overage) ──────────────────────────────────── */}
      <div className="card mt-4 p-5">
        <h2 className="font-bold">Need more credits?</h2>
        <p className="mt-1 text-sm text-slate-500">
          One-time top-ups for when you run low mid-cycle. Top-up credits <strong>roll over</strong> — they don't expire at renewal.
        </p>
        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          {TOPUP_PACKS.map((pack) => (
            <div key={pack.id} className={`rounded-lg border p-4 text-center ${pack.popular ? 'border-brand-400 bg-brand-50' : 'border-slate-200'}`}>
              {pack.popular && <span className="mb-1 inline-block rounded-full bg-brand-600 px-2 py-0.5 text-[10px] font-bold text-white">BEST VALUE</span>}
              <p className="text-lg font-bold">{pack.credits.toLocaleString()} credits</p>
              <p className="text-sm text-slate-500">{CURRENCY.symbol}{pack.price}</p>
              <button
                onClick={() => buyTopup(pack.id)}
                disabled={topupBusy === pack.id}
                className="btn-ghost mt-3 w-full"
              >
                {topupBusy === pack.id ? '…' : 'Buy'}
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
