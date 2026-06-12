import { useState } from 'react';
import { TOOLS, CATEGORIES, tierMeets } from '@shared/catalog.mjs';
import { useAuth } from '../context/AuthContext.jsx';
import ToolCard from '../components/ToolCard.jsx';

export default function Dashboard() {
  const { user } = useAuth();
  const [q, setQ] = useState('');
  const [cat, setCat] = useState('All');

  const filtered = TOOLS.filter(
    (t) =>
      (cat === 'All' || t.category === cat) &&
      (q === '' || (t.name + t.desc).toLowerCase().includes(q.toLowerCase()))
  );
  const lockedCount = TOOLS.filter((t) => !tierMeets(user.tier, t.minTier)).length;

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Welcome back, {user.name?.split(' ')[0] || 'there'} 👋</h1>
          <p className="mt-1 text-slate-600">
            {TOOLS.length} tools · {lockedCount > 0 ? `${lockedCount} unlock at higher tiers` : 'all unlocked'}
          </p>
        </div>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search tools…"
          className="w-64 rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none"
        />
      </div>

      <div className="mt-6 flex flex-wrap gap-2">
        {['All', ...CATEGORIES].map((c) => (
          <button
            key={c}
            onClick={() => setCat(c)}
            className={`rounded-full px-3 py-1.5 text-sm font-medium ${
              cat === c ? 'bg-brand-600 text-white' : 'bg-white text-slate-600 ring-1 ring-slate-200 hover:bg-slate-50'
            }`}
          >
            {c}
          </button>
        ))}
      </div>

      <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {filtered.map((t) => (
          <ToolCard key={t.id} tool={t} userTier={user.tier} />
        ))}
      </div>
    </div>
  );
}
