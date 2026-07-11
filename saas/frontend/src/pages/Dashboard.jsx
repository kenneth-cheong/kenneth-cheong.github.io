import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Clock, Check } from 'lucide-react';
import { TOOLS, CATEGORIES, GOALS, SIMPLE_NAMES, toolById, tierMeets } from '@shared/catalog.mjs';
import { useAuth } from '../context/AuthContext.jsx';
import { useProjects } from '../context/ProjectContext.jsx';
import { api } from '../lib/api.js';
import ToolCard from '../components/ToolCard.jsx';
import ProfilePrompt from '../components/ProfilePrompt.jsx';
import GoalPlanner from '../components/GoalPlanner.jsx';
import { CategoryIcon } from '../lib/icons.jsx';
import { getRecent, isStepDone } from '../lib/ui.js';

// The setup checklist's "first action" step, tailored to the goal the user
// picked in the welcome flow — so step 2 matches what they said they want.
// `connect` steps complete on a Google connection; the rest on any tool run.
const GOAL_STEPS = {
  visitors: { title: 'Find your first keywords', body: 'See volume & difficulty for terms you want to rank for.', to: '/tool/keyword-analysis', cta: 'Find keywords' },
  health: { title: 'Run a site health check', body: 'Get a scored report and a prioritised fix list.', to: '/audit', cta: 'Run check' },
  content: { title: 'Write your first content', body: 'Draft a post, caption or plan that ranks.', to: '/tool/content-writer', cta: 'Start writing' },
  rankings: { title: 'Track a keyword', body: 'Watch a keyword’s Google position over time.', to: '/tracking', cta: 'Track one' },
  'ai-visibility': { title: 'Check your AI visibility', body: 'See if ChatGPT, Gemini & Perplexity cite you.', to: '/tool/ai-discovery', cta: 'Check now' },
  competitors: { title: 'Size up a competitor', body: 'See who you’re up against and how you compare.', to: '/tool/competitors', cta: 'Compare' },
  'my-data': { title: 'Connect Google', body: 'Pull your Search Console / GA4 / Ads data.', to: '/integrations', cta: 'Connect', connect: true },
};

// Plain-language overrides for Simple mode (beginners), pro labels otherwise.
const display = (t, simple) => (simple && SIMPLE_NAMES[t.id] ? { ...t, ...SIMPLE_NAMES[t.id] } : t);

export default function Dashboard() {
  const { user, setOnboarding } = useAuth();
  const { projects } = useProjects();
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState('');
  const [cat, setCat] = useState('All');
  const [plannerGoal, setPlannerGoal] = useState(null); // goal id deep-linked from the welcome flow
  const [googleConnected, setGoogleConnected] = useState(false);
  const [mode, setMode] = useState(() => {
    const saved = localStorage.getItem('dm_view_mode');
    if (saved === 'simple' || saved === 'advanced') return saved;
    // Default experienced users (have run tools) to Advanced; newcomers to Simple.
    return getRecent().length ? 'advanced' : 'simple';
  });
  const simple = mode === 'simple';
  // Flash the Simple/Advanced toggle to draw the eye until the user first uses
  // it — then stop nagging (remembered across sessions).
  const [switchSeen, setSwitchSeen] = useState(() => localStorage.getItem('dm_mode_switch_seen') === '1');
  const setView = (m) => {
    setMode(m);
    localStorage.setItem('dm_view_mode', m);
    if (!switchSeen) { setSwitchSeen(true); localStorage.setItem('dm_mode_switch_seen', '1'); }
  };

  // Arriving from the welcome flow with ?goal=<id> → open Simple mode and hand
  // the goal to the planner as a starting selection, then strip the param so a
  // refresh doesn't re-pin it. Keyed on the param value (not mount) because the
  // dashboard is already mounted under the welcome overlay when it navigates
  // here, so a mount-only effect never fires.
  const goalParam = params.get('goal');
  useEffect(() => {
    if (goalParam && GOALS.some((x) => x.id === goalParam)) {
      setMode('simple'); setPlannerGoal(goalParam);
      const next = new URLSearchParams(params); next.delete('goal'); setParams(next, { replace: true });
    }
  }, [goalParam]); // eslint-disable-line react-hooks/exhaustive-deps

  const [showOnboard, setShowOnboard] = useState(() => !user.onboarding?.dismissedChecklist && localStorage.getItem('dm_onboard_done') !== '1');
  const dismissOnboard = () => { setShowOnboard(false); localStorage.setItem('dm_onboard_done', '1'); setOnboarding({ dismissedChecklist: true }); };
  useEffect(() => { api.integrations().then((d) => setGoogleConnected(Object.values(d.connected || {}).some((c) => c?.connected))).catch(() => {}); }, []);

  const match = (t) => q === '' || (t.name + t.desc + (SIMPLE_NAMES[t.id]?.name || '')).toLowerCase().includes(q.toLowerCase());
  const filtered = TOOLS.filter((t) => (cat === 'All' || t.category === cat) && match(t));
  const lockedCount = TOOLS.filter((t) => !tierMeets(user.tier, t.minTier)).length;
  const recent = getRecent().map(toolById).filter(Boolean).filter(match);
  const searching = q !== '';

  const Card = (t) => <ToolCard key={t.id} tool={display(t, simple)} userTier={user.tier} />;

  // Onboarding checklist — real progress, shown until dismissed. The middle
  // "first action" step is goal-aware: it reflects the goal chosen in the
  // welcome flow (falling back to a generic "run a tool" step).
  const chosenGoal = user.onboarding?.goal;
  const gStep = GOAL_STEPS[chosenGoal];
  // A step pointing at a specific tool (/tool/<id>) completes only when THAT
  // tool has been run — so "Find your first keywords" needs the keyword tool,
  // not just any tool. Non-tool steps (audit, tracking) keep "any tool run"
  // since they have no per-tool signal in the recents list.
  const ranTools = getRecent();
  const stepDone = (step) => {
    if (step.connect) return googleConnected;
    // The Health Check and Rank Tracking don't run through ToolRunner, so they
    // record their own completion markers rather than appearing in `ranTools`.
    if (step.to === '/audit') return isStepDone('audit');
    if (step.to === '/tracking') return isStepDone('tracking');
    const toolId = step.to?.startsWith('/tool/') ? step.to.slice('/tool/'.length) : null;
    return toolId ? ranTools.includes(toolId) : ranTools.length > 0;
  };
  const actionStep = gStep
    ? { ...gStep, done: stepDone(gStep) }
    : { done: ranTools.length > 0, title: 'Run your first tool', body: 'Try Keyword Analysis — it’s free.', to: '/tool/keyword-analysis', cta: 'Try it' };
  const steps = [
    { done: projects.length > 0, title: 'Create a project', body: 'Group a site’s runs and data.', to: '/projects', cta: 'New project' },
    actionStep,
    { done: googleConnected, title: 'Connect Google', body: 'Pull your Search Console / GA4 / Ads data.', to: '/integrations', cta: 'Connect' },
  // Drop a duplicate (e.g. the 'my-data' goal step IS "Connect Google").
  ].filter((s, i, arr) => arr.findIndex((x) => x.to === s.to) === i);
  const allDone = steps.every((s) => s.done);

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Welcome back, {user.name?.split(' ')[0] || 'there'}</h1>
          <p className="mt-1 text-dim">
            {simple ? 'What would you like to get done today?' : `${TOOLS.length} tools · ${lockedCount > 0 ? `${lockedCount} unlock at higher tiers` : 'all unlocked'}`}
          </p>
        </div>
        <div className="flex items-center gap-3">
          {/* Simple ↔ Advanced view toggle */}
          <div className="flex items-center gap-2">
            <span className="hidden text-xs font-medium uppercase tracking-wide text-faint sm:inline">View</span>
            <div className={`flex rounded-lg bg-sunken p-0.5 text-sm font-medium ${switchSeen ? '' : 'dm-mode-attn'}`}>
              {[['simple', 'Simple'], ['advanced', 'Advanced']].map(([m, label]) => (
                <button key={m} onClick={() => setView(m)}
                  className={`rounded-md px-3 py-1 transition-colors ${mode === m ? 'bg-surface text-strong shadow-sm' : 'text-muted hover:text-body'}`}>
                  {label}
                </button>
              ))}
            </div>
          </div>
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search tools…"
            data-tour="search"
            className="w-full rounded-lg border border-edge px-3 py-2 text-sm focus:border-brand-500 focus:outline-none sm:w-56"
          />
        </div>
      </div>

      {/* Onboarding checklist (until all done or dismissed) */}
      {showOnboard && !allDone && !searching && (
        <div className="mt-6 rounded-xl border border-brand-200 dark:border-brand-500/30 bg-brand-50/60 dark:bg-brand-500/10 p-5">
          <div className="flex items-start justify-between">
            <h2 className="font-semibold text-brand-800 dark:text-brand-300">Get set up — {steps.filter((s) => s.done).length}/{steps.length} done</h2>
            <button onClick={dismissOnboard} className="text-sm text-faint hover:text-body">Dismiss</button>
          </div>
          <ol className="dm-steps-grid mt-3">
            {steps.map((s, i) => <Step key={i} n={i + 1} {...s} />)}
          </ol>
        </div>
      )}

      {/* Progressive-profiling nudge — self-hides when complete/rewarded/snoozed */}
      {!searching && <ProfilePrompt />}

      {/* ───────── Simple mode: goal intake → agentic pathway ───────── */}
      {simple && !searching ? (
        <>
          <GoalPlanner initialGoal={plannerGoal} />
          {recent.length > 0 && (
            <Section title="Recently used" icon={<Clock size={14} aria-hidden />}>{recent.map((t) => Card(t))}</Section>
          )}
        </>
      ) : (
        /* ───────── Advanced mode (or searching): full tool grid ───────── */
        <>
          <div className="mt-6 flex flex-wrap gap-2" data-tour="categories">
            {['All', ...CATEGORIES].map((c) => (
              <button key={c} onClick={() => setCat(c)}
                className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm font-medium ${cat === c ? 'bg-brand-600 text-white' : 'bg-surface text-dim ring-1 ring-line hover:bg-raised'}`}>
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
            <div className="dm-card-grid mt-6">
              {filtered.length === 0 && <p className="text-faint">No tools match “{q}”.</p>}
              {filtered.map((t) => Card(t))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function Step({ n, done, title, body, to, cta }) {
  return (
    <li className={`rounded-lg border bg-surface p-3 ${done ? 'border-green-200 dark:border-green-500/30' : 'border-brand-100 dark:border-brand-500/25'}`}>
      <div className="flex items-center gap-2">
        <span className={`grid h-5 w-5 place-items-center rounded-full text-xs font-bold text-white ${done ? 'bg-green-500' : 'bg-brand-600'}`}>{done ? <Check size={12} aria-hidden /> : n}</span>
        <span className={`font-semibold ${done ? 'text-faint line-through' : 'text-strong'}`}>{title}</span>
      </div>
      {!done && <p className="mt-1 text-sm text-muted">{body}</p>}
      {!done && <Link to={to} className="mt-2 inline-block text-sm font-medium text-brand-600 dark:text-brand-400 hover:text-brand-700 dark:hover:text-brand-300">{cta} →</Link>}
    </li>
  );
}

function Section({ title, icon, children }) {
  return (
    <section className="mt-8">
      <h2 className="mb-3 flex items-center gap-2 text-sm font-bold uppercase tracking-wide text-muted">{icon}{title}</h2>
      <div className="dm-card-grid">{children}</div>
    </section>
  );
}
