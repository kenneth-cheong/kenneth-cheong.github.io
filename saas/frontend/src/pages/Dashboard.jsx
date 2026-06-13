import { useState } from 'react';
import { TOOLS, CATEGORIES, CATEGORY_META, toolById, tierMeets } from '@shared/catalog.mjs';
import { useAuth } from '../context/AuthContext.jsx';
import ToolCard from '../components/ToolCard.jsx';
import { getRecent } from '../lib/ui.js';

export default function Dashboard() {
  const { user } = useAuth();
  const [q, setQ] = useState('');
  const [cat, setCat] = useState('All');

  const match = (t) => q === '' || (t.name + t.desc).toLowerCase().includes(q.toLowerCase());
  const filtered = TOOLS.filter((t) => (cat === 'All' || t.category === cat) && match(t));
  const lockedCount = TOOLS.filter((t) => !tierMeets(user.tier, t.minTier)).length;
  const recent = getRecent().map(toolById).filter(Boolean).filter(match);
  const searching = q !== '';

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
          className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none sm:w-64"
        />
      </div>

      <div className="mt-6 flex flex-wrap gap-2">
        {['All', ...CATEGORIES].map((c) => (
          <button
            key={c}
            onClick={() => setCat(c)}
            className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm font-medium ${
              cat === c ? 'bg-brand-600 text-white' : 'bg-white text-slate-600 ring-1 ring-slate-200 hover:bg-slate-50'
            }`}
          >
            {c !== 'All' && <span aria-hidden>{CATEGORY_META[c]?.icon}</span>}{c}
          </button>
        ))}
      </div>

      {/* Recently used (only on the unfiltered landing view) */}
      {cat === 'All' && !searching && recent.length > 0 && (
        <Section title="Recently used" icon="🕘">
          {recent.map((t) => <ToolCard key={t.id} tool={t} userTier={user.tier} />)}
        </Section>
      )}

      {/* Grouped by category when browsing "All"; flat grid when filtered/searching */}
      {cat === 'All' && !searching ? (
        CATEGORIES.map((c) => {
          const tools = TOOLS.filter((t) => t.category === c);
          if (!tools.length) return null;
          return (
            <Section key={c} title={c} icon={CATEGORY_META[c]?.icon}>
              {tools.map((t) => <ToolCard key={t.id} tool={t} userTier={user.tier} />)}
            </Section>
          );
        })
      ) : (
        <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {filtered.length === 0 && <p className="text-slate-400">No tools match “{q}”.</p>}
          {filtered.map((t) => <ToolCard key={t.id} tool={t} userTier={user.tier} />)}
        </div>
      )}
    </div>
  );
}

function Section({ title, icon, children }) {
  return (
    <section className="mt-8">
      <h2 className="mb-3 flex items-center gap-2 text-sm font-bold uppercase tracking-wide text-slate-500">
        <span aria-hidden>{icon}</span>{title}
      </h2>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">{children}</div>
    </section>
  );
}
