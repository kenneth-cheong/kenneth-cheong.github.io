import { useState } from 'react';
import { Link } from 'react-router-dom';
import { TOOLS, CATEGORIES, CATEGORY_META, toolById, tierMeets } from '@shared/catalog.mjs';
import { useAuth } from '../context/AuthContext.jsx';
import { useProjects } from '../context/ProjectContext.jsx';
import ToolCard from '../components/ToolCard.jsx';
import { getRecent } from '../lib/ui.js';

export default function Dashboard() {
  const { user } = useAuth();
  const { projects } = useProjects();
  const [q, setQ] = useState('');
  const [cat, setCat] = useState('All');
  const [showOnboard, setShowOnboard] = useState(() => localStorage.getItem('dm_onboard_done') !== '1');

  const match = (t) => q === '' || (t.name + t.desc).toLowerCase().includes(q.toLowerCase());
  const filtered = TOOLS.filter((t) => (cat === 'All' || t.category === cat) && match(t));
  const lockedCount = TOOLS.filter((t) => !tierMeets(user.tier, t.minTier)).length;
  const recent = getRecent().map(toolById).filter(Boolean).filter(match);
  const searching = q !== '';
  const isNew = recent.length === 0 && projects.length === 0;

  function dismissOnboard() { setShowOnboard(false); localStorage.setItem('dm_onboard_done', '1'); }

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

      {showOnboard && isNew && (
        <div className="mt-6 rounded-xl border border-brand-200 bg-brand-50/60 p-5">
          <div className="flex items-start justify-between">
            <h2 className="font-semibold text-brand-800">Get started in 3 steps</h2>
            <button onClick={dismissOnboard} className="text-sm text-slate-400 hover:text-slate-700">Dismiss</button>
          </div>
          <ol className="mt-3 grid gap-3 sm:grid-cols-3">
            <Step n="1" title="Create a project" body="Group a site's runs and data." to="/projects" cta="New project" />
            <Step n="2" title="Run a free tool" body="Try Keyword Analysis — no credits." to="/tool/keyword-analysis" cta="Try it" />
            <Step n="3" title="Connect Google" body="Pull your GSC / GA4 / Ads data." to="/integrations" cta="Connect" />
          </ol>
        </div>
      )}

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

function Step({ n, title, body, to, cta }) {
  return (
    <li className="rounded-lg border border-brand-100 bg-white p-3">
      <div className="flex items-center gap-2"><span className="grid h-5 w-5 place-items-center rounded-full bg-brand-600 text-xs font-bold text-white">{n}</span><span className="font-semibold text-slate-800">{title}</span></div>
      <p className="mt-1 text-sm text-slate-500">{body}</p>
      <Link to={to} className="mt-2 inline-block text-sm font-medium text-brand-600 hover:text-brand-700">{cta} →</Link>
    </li>
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
