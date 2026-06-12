import { useState } from 'react';
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
        <p className="mt-2 text-slate-600">Every plan includes the credit meter, projects and exports. Cancel anytime.</p>
        <div className="mt-5 inline-flex rounded-full bg-slate-100 p-1 text-sm font-medium">
          {['monthly', 'annual'].map((iv) => (
            <button
              key={iv}
              onClick={() => setInterval(iv)}
              className={`rounded-full px-4 py-1.5 capitalize ${interval === iv ? 'bg-white shadow text-brand-700' : 'text-slate-500'}`}
            >
              {iv} {iv === 'annual' && <span className="text-green-600">−2 months</span>}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-8 grid gap-5 lg:grid-cols-4">
        {ORDER.map((id) => {
          const p = PLANS[id];
          const current = user.tier === id;
          const price = interval === 'annual' ? Math.round(p.priceMonthly * 10 / 12) : p.priceMonthly;
          return (
            <div key={id} className={`card flex flex-col p-5 ${p.popular ? 'ring-2 ring-brand-500' : ''}`}>
              {p.popular && <span className="mb-2 w-fit rounded-full bg-brand-600 px-2 py-0.5 text-xs font-bold text-white">MOST POPULAR</span>}
              <h3 className="text-lg font-bold">{p.name}</h3>
              <p className="mt-1 text-sm text-slate-500">{p.blurb}</p>
              <div className="mt-4">
                <span className="text-3xl font-bold">{CURRENCY.symbol}{price}</span>
                <span className="text-sm text-slate-500">/mo</span>
              </div>
              <ul className="mt-4 flex-1 space-y-2 text-sm">
                {p.highlights.map((h) => (
                  <li key={h} className="flex gap-2"><span className="text-brand-600">✓</span>{h}</li>
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
