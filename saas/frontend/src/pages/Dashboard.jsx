import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Clock, Check, TrendingUp, Stethoscope, PenLine, LineChart, Sparkles, Swords, BarChart3, ChevronRight } from 'lucide-react';
import { TOOLS, CATEGORIES, GOALS, SIMPLE_NAMES, toolById, tierMeets } from '@shared/catalog.mjs';
import { useAuth } from '../context/AuthContext.jsx';
import { useProjects } from '../context/ProjectContext.jsx';
import { api } from '../lib/api.js';
import ToolCard from '../components/ToolCard.jsx';
import { CategoryIcon } from '../lib/icons.jsx';
import { getRecent } from '../lib/ui.js';

const GOAL_ICON = { TrendingUp, Stethoscope, PenLine, LineChart, Sparkles, Swords, BarChart3 };

// Plain-language overrides for Simple mode (beginners), pro labels otherwise.
const display = (t, simple) => (simple && SIMPLE_NAMES[t.id] ? { ...t, ...SIMPLE_NAMES[t.id] } : t);

export default function Dashboard() {
  const { user } = useAuth();
  const { projects } = useProjects();
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const [cat, setCat] = useState('All');
  const [activeGoal, setActiveGoal] = useState(null);
  const [googleConnected, setGoogleConnected] = useState(false);
  const [mode, setMode] = useState(() => {
    const saved = localStorage.getItem('dm_view_mode');
    if (saved === 'simple' || saved === 'advanced') return saved;
    // Default experienced users (have run tools) to Advanced; newcomers to Simple.
    return getRecent().length ? 'advanced' : 'simple';
  });
  const simple = mode === 'simple';
  const setView = (m) => { setMode(m); localStorage.setItem('dm_view_mode', m); setActiveGoal(null); };

  const [showOnboard, setShowOnboard] = useState(() => localStorage.getItem('dm_onboard_done') !== '1');
  useEffect(() => { api.integrations().then((d) => setGoogleConnected(Object.values(d.connected || {}).some((c) => c?.connected))).catch(() => {}); }, []);

  const match = (t) => q === '' || (t.name + t.desc + (SIMPLE_NAMES[t.id]?.name || '')).toLowerCase().includes(q.toLowerCase());
  const filtered = TOOLS.filter((t) => (cat === 'All' || t.category === cat) && match(t));
  const lockedCount = TOOLS.filter((t) => !tierMeets(user.tier, t.minTier)).length;
  const recent = getRecent().map(toolById).filter(Boolean).filter(match);
  const searching = q !== '';

  const goal = GOALS.find((g) => g.id === activeGoal);
  const goalTools = goal ? goal.tools.map(toolById).filter(Boolean) : [];
  const Card = (t) => <ToolCard key={t.id} tool={display(t, simple)} userTier={user.tier} />;

  // Onboarding checklist — real progress, shown until dismissed.
  const steps = [
    { done: projects.length > 0, title: 'Create a project', body: 'Group a site’s runs and data.', to: '/projects', cta: 'New project' },
    { done: getRecent().length > 0, title: 'Run your first tool', body: 'Try Keyword Analysis — it’s free.', to: '/tool/keyword-analysis', cta: 'Try it' },
    { done: googleConnected, title: 'Connect Google', body: 'Pull your Search Console / GA4 / Ads data.', to: '/integrations', cta: 'Connect' },
  ];
  const allDone = steps.every((s) => s.done);

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Welcome back, {user.name?.split(' ')[0] || 'there'}</h1>
          <p className="mt-1 text-slate-600">
            {simple ? 'What would you like to get done today?' : `${TOOLS.length} tools · ${lockedCount > 0 ? `${lockedCount} unlock at higher tiers` : 'all unlocked'}`}
          </p>
        </div>
        <div className="flex items-center gap-3">
          {/* Simple ↔ Advanced view toggle */}
          <div className="flex rounded-lg bg-slate-100 p-0.5 text-sm font-medium">
            {[['simple', 'Simple'], ['advanced', 'Advanced']].map(([m, label]) => (
              <button key={m} onClick={() => setView(m)}
                className={`rounded-md px-3 py-1 ${mode === m ? 'bg-white text-slate-800 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}>
                {label}
              </button>
            ))}
          </div>
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search tools…"
            data-tour="search"
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none sm:w-56"
          />
        </div>
      </div>

      {/* Onboarding checklist (until all done or dismissed) */}
      {showOnboard && !allDone && !searching && !activeGoal && (
        <div className="mt-6 rounded-xl border border-brand-200 bg-brand-50/60 p-5">
          <div className="flex items-start justify-between">
            <h2 className="font-semibold text-brand-800">Get set up — {steps.filter((s) => s.done).length}/{steps.length} done</h2>
            <button onClick={() => { setShowOnboard(false); localStorage.setItem('dm_onboard_done', '1'); }} className="text-sm text-slate-400 hover:text-slate-700">Dismiss</button>
          </div>
          <ol className="mt-3 grid gap-3 sm:grid-cols-3">
            {steps.map((s, i) => <Step key={i} n={i + 1} {...s} />)}
          </ol>
        </div>
      )}

      {/* ───────── Simple mode: goal-first ───────── */}
      {simple && !searching ? (
        activeGoal ? (
          <section className="mt-8">
            <button onClick={() => setActiveGoal(null)} className="text-sm font-medium text-brand-600 hover:text-brand-700">← All goals</button>
            <h2 className="mt-2 text-lg font-bold">{goal.label}</h2>
            <p className="text-sm text-slate-500">{goal.desc}</p>
            {goal.to && (
              <Link to={goal.to} className="btn-primary mt-3 inline-block">Open {goal.label.toLowerCase()} →</Link>
            )}
            <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">{goalTools.map(Card)}</div>
          </section>
        ) : (
          <>
            <section className="mt-8">
              <h2 className="mb-3 text-sm font-bold uppercase tracking-wide text-slate-500">What do you want to do?</h2>
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {GOALS.map((g) => <GoalCard key={g.id} goal={g} onClick={() => (g.to && g.tools.length <= 1 ? navigate(g.to) : setActiveGoal(g.id))} />)}
              </div>
            </section>
            {recent.length > 0 && (
              <Section title="Recently used" icon={<Clock size={14} aria-hidden />}>{recent.map((t) => Card(t))}</Section>
            )}
          </>
        )
      ) : (
        /* ───────── Advanced mode (or searching): full tool grid ───────── */
        <>
          <div className="mt-6 flex flex-wrap gap-2" data-tour="categories">
            {['All', ...CATEGORIES].map((c) => (
              <button key={c} onClick={() => setCat(c)}
                className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm font-medium ${cat === c ? 'bg-brand-600 text-white' : 'bg-white text-slate-600 ring-1 ring-slate-200 hover:bg-slate-50'}`}>
                {c !== 'All' && <CategoryIcon category={c} size={14} />}{c}
              </button>
            ))}
          </div>

          {cat === 'All' && !searching && recent.length > 0 && (
            <Section title="Recently used" icon={<Clock size={14} aria-hidden />}>{recent.map((t) => Card(t))}</Section>
          )}

          {cat === 'All' && !searching ? (
            CATEGORIES.map((c) => {
              const tools = TOOLS.filter((t) => t.category === c);
              if (!tools.length) return null;
              return <Section key={c} title={c} icon={<CategoryIcon category={c} size={14} />}>{tools.map((t) => Card(t))}</Section>;
            })
          ) : (
            <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {filtered.length === 0 && <p className="text-slate-400">No tools match “{q}”.</p>}
              {filtered.map((t) => Card(t))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function GoalCard({ goal, onClick }) {
  const Icon = GOAL_ICON[goal.icon] || Sparkles;
  return (
    <button onClick={onClick} className="card group flex items-start gap-3 p-4 text-left transition hover:-translate-y-0.5 hover:border-brand-400 hover:shadow-lift">
      <span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-brand-50 text-brand-600"><Icon size={20} aria-hidden /></span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1 font-semibold text-slate-800">{goal.label} <ChevronRight size={15} className="text-slate-300 transition group-hover:translate-x-0.5 group-hover:text-brand-500" aria-hidden /></span>
        <span className="mt-0.5 block text-sm text-slate-500">{goal.desc}</span>
      </span>
    </button>
  );
}

function Step({ n, done, title, body, to, cta }) {
  return (
    <li className={`rounded-lg border bg-white p-3 ${done ? 'border-green-200' : 'border-brand-100'}`}>
      <div className="flex items-center gap-2">
        <span className={`grid h-5 w-5 place-items-center rounded-full text-xs font-bold text-white ${done ? 'bg-green-500' : 'bg-brand-600'}`}>{done ? <Check size={12} aria-hidden /> : n}</span>
        <span className={`font-semibold ${done ? 'text-slate-400 line-through' : 'text-slate-800'}`}>{title}</span>
      </div>
      {!done && <p className="mt-1 text-sm text-slate-500">{body}</p>}
      {!done && <Link to={to} className="mt-2 inline-block text-sm font-medium text-brand-600 hover:text-brand-700">{cta} →</Link>}
    </li>
  );
}

function Section({ title, icon, children }) {
  return (
    <section className="mt-8">
      <h2 className="mb-3 flex items-center gap-2 text-sm font-bold uppercase tracking-wide text-slate-500">{icon}{title}</h2>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">{children}</div>
    </section>
  );
}
