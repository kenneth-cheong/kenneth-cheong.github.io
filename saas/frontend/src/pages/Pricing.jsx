import { useState } from 'react';
import { Check } from 'lucide-react';
import { PLANS, tierRank, CURRENCY } from '@shared/catalog.mjs';
import { useAuth } from '../context/AuthContext.jsx';
import { api } from '../lib/api.js';

const ORDER = ['free', 'starter', 'pro', 'expert'];

export default function Pricing() {
  const { user } = useAuth();
  const [interval, setInterval] = useState('monthly');
  const [busy, setBusy] = useState(null);

  async function choose(tier) {
    if (tier === 'free' || tier === user.tier) return;
    setBusy(tier);
    try {
      const { url } = await api.checkout(tier, interval);
      window.location.href = url;
    } finally {
      setBusy(null);
    }
  }

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
              onClick={() => setInterval(iv)}
              className={`rounded-full px-4 py-1.5 capitalize ${interval === iv ? 'bg-surface shadow text-brand-700 dark:text-brand-300' : 'text-muted'}`}
            >
              {iv} {iv === 'annual' && <span className="text-green-600 dark:text-green-400">−20%</span>}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-8 grid gap-5 lg:grid-cols-4">
        {ORDER.map((id) => {
          const p = PLANS[id];
          const current = user.tier === id;
          const price = interval === 'annual' ? Math.round(p.priceMonthly * 0.8) : p.priceMonthly;
          return (
            <div key={id} className={`card flex flex-col p-5 ${p.popular ? 'ring-2 ring-brand-500' : ''}`}>
              {p.popular && <span className="mb-2 w-fit rounded-full bg-brand-600 px-2 py-0.5 text-xs font-bold text-white">MOST POPULAR</span>}
              <h3 className="text-lg font-bold">{p.name}</h3>
              <p className="mt-1 text-sm text-muted">{p.blurb}</p>
              <div className="mt-4">
                <span className="text-3xl font-bold">{CURRENCY.symbol}{price}</span>
                <span className="text-sm text-muted">/mo</span>
              </div>
              <ul className="mt-4 flex-1 space-y-2 text-sm">
                {p.highlights.map((h) => (
                  <li key={h} className="flex items-center gap-2"><Check size={15} className="shrink-0 text-brand-600 dark:text-brand-400" aria-hidden />{h}</li>
                ))}
              </ul>
              <button
                onClick={() => choose(id)}
                disabled={current || busy === id || id === 'free'}
                className={`mt-5 ${p.popular ? 'btn-primary' : 'btn-ghost'} w-full disabled:opacity-60`}
              >
                {current ? 'Current plan' : id === 'free' ? 'Free forever' : busy === id ? '…' :
                  tierRank(id) > tierRank(user.tier) ? `Upgrade to ${p.name}` : `Switch to ${p.name}`}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
