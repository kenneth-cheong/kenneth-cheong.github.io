import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  TrendingUp, Stethoscope, PenLine, LineChart, Sparkles, Swords, BarChart3,
  Check, ArrowRight, ArrowUp, Lock, Wand2, Plug, RotateCcw, PartyPopper,
} from 'lucide-react';
import {
  GOALS, INTAKE, SIMPLE_NAMES, PLANS, buildPathway, toolById,
} from '@shared/catalog.mjs';
import { useAuth } from '../context/AuthContext.jsx';
import { usePlan } from '../context/PlanContext.jsx';
import { api } from '../lib/api.js';
import { getRecent, toast } from '../lib/ui.js';
import { enrichPathway, stepTarget, stepLabel } from '../lib/planner.js';

const GOAL_ICON = { TrendingUp, Stethoscope, PenLine, LineChart, Sparkles, Swords, BarChart3 };

export default function GoalPlanner({ initialGoal }) {
  const { user, setCredits, setOnboarding } = useAuth();
  const { plan, hasPlan, setPlan, clearPlan, progress } = usePlan();
  const navigate = useNavigate();

  const [editing, setEditing] = useState(false);
  const [goals, setGoals] = useState([]);
  const [have, setHave] = useState([]);
  const [freeText, setFreeText] = useState('');
  const [enriching, setEnriching] = useState(false);
  const [hasGoogle, setHasGoogle] = useState(false);
  const [seeded, setSeeded] = useState(false);
  const [nudge, setNudge] = useState(false);

  useEffect(() => {
    api.integrations().then((d) => setHasGoogle(Object.values(d.connected || {}).some((c) => c?.connected))).catch(() => {});
  }, []);

  // Seed the intake form the first time we know there's no plan (deep-link or a
  // previously-chosen goal). With a plan present we seed on demand via Edit goals.
  useEffect(() => {
    if (seeded || hasPlan) return;
    setSeeded(true);
    setGoals(initialGoal ? [initialGoal] : user.onboarding?.goal ? [user.onboarding.goal] : []);
  }, [seeded, hasPlan, initialGoal, user.onboarding?.goal]);

  // Welcome-flow deep-link (?goal=…) → build immediately if there's no plan yet.
  useEffect(() => {
    if (initialGoal && !hasPlan) build([initialGoal], []);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialGoal]);

  const showIntake = !hasPlan || editing;
  const toggle = (arr, set, id) => set(arr.includes(id) ? arr.filter((x) => x !== id) : [...arr, id]);

  function build(goalIds = goals, haveIds = have) {
    const base = buildPathway({ goalIds, have: haveIds, tier: user.tier, hasGoogle, ranTools: getRecent() });
    setPlan({
      goals: goalIds, have: haveIds, freeText,
      steps: base.steps, locked: base.locked, extras: base.extras, quickWin: base.quickWin,
      aiRefined: false, done: {},
    });
    setEditing(false);
    if (goalIds[0] && user.onboarding?.goal !== goalIds[0]) setOnboarding({ goal: goalIds[0] }).catch(() => {});
  }

  async function personalise() {
    setEnriching(true);
    const result = await enrichPathway(plan, { freeText: plan.freeText, user, onCredits: (c, t) => setCredits(c, t) });
    setPlan(result); // enrichPathway spreads `plan`, so goals/have/freeText/done are preserved
    setEnriching(false);
    if (!result.aiRefined) toast('Couldn’t personalise just now — here’s your standard plan.', 'info');
  }

  function startEdit() { setGoals(plan?.goals || []); setHave(plan?.have || []); setFreeText(plan?.freeText || ''); setEditing(true); }
  function reset() { clearPlan(); setEditing(false); setGoals([]); setHave([]); setFreeText(''); }

  const go = (item) => navigate(stepTarget(item).to);

  // ── Intake ──────────────────────────────────────────────────────────────────
  if (showIntake) {
    return (
      <section className="mt-8" data-tour="pathway">
        <div className="flex items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2.5">
            <h2 className="text-lg font-bold text-heading">{INTAKE.goalQuestion}</h2>
            <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${goals.length ? 'bg-brand-100 dark:bg-brand-500/15 text-brand-700 dark:text-brand-300' : 'bg-amber-100 dark:bg-amber-500/15 text-amber-700 dark:text-amber-300'}`}>
              {goals.length ? `${goals.length} selected` : 'Pick at least 1'}
            </span>
          </div>
          {hasPlan && <button onClick={() => setEditing(false)} className="text-sm font-medium text-muted hover:text-body">Cancel</button>}
        </div>
        <p className="mt-1 text-sm text-muted">{INTAKE.goalHint}</p>

        <div
          id="goal-grid"
          className={`dm-card-grid mt-4 rounded-2xl transition ${nudge && goals.length === 0 ? 'p-3 ring-2 ring-amber-400 ring-offset-2 ring-offset-white' : ''}`}
        >
          {GOALS.map((g) => {
            const Icon = GOAL_ICON[g.icon] || Sparkles;
            const on = goals.includes(g.id);
            return (
              <button
                key={g.id}
                onClick={() => { toggle(goals, setGoals, g.id); setNudge(false); }}
                aria-pressed={on}
                className={`card group flex items-start gap-3 p-4 text-left transition hover:-translate-y-0.5 hover:shadow-lift ${on ? 'border-brand-500 ring-2 ring-brand-200' : 'hover:border-brand-400'}`}
              >
                <span className={`grid h-10 w-10 shrink-0 place-items-center rounded-lg ${on ? 'bg-brand-600 text-white' : 'bg-brand-50 dark:bg-brand-500/10 text-brand-600 dark:text-brand-400'}`}>
                  {on ? <Check size={20} aria-hidden /> : <Icon size={20} aria-hidden />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block font-semibold text-strong">{g.label}</span>
                  <span className="mt-0.5 block text-sm text-muted">{g.desc}</span>
                </span>
              </button>
            );
          })}
        </div>

        <div className="mt-6">
          <h3 className="text-sm font-semibold text-body">{INTAKE.context.question}</h3>
          <div className="mt-2 flex flex-wrap gap-2">
            {INTAKE.context.options.map((o) => {
              const on = have.includes(o.id);
              return (
                <button
                  key={o.id}
                  onClick={() => toggle(have, setHave, o.id)}
                  aria-pressed={on}
                  className={`rounded-full px-3 py-1.5 text-sm font-medium ring-1 transition ${on ? 'bg-brand-600 text-white ring-brand-600' : 'bg-surface text-dim ring-line hover:bg-raised'}`}
                >
                  {o.label}
                </button>
              );
            })}
          </div>
        </div>

        <div className="mt-6">
          <label htmlFor="planner-goal" className="text-sm font-semibold text-body">
            Anything specific? <span className="font-normal text-faint">(optional)</span>
          </label>
          <textarea
            id="planner-goal"
            value={freeText}
            onChange={(e) => setFreeText(e.target.value)}
            rows={2}
            placeholder="e.g. “Launch my new bakery site in Singapore and get my first 100 visitors”"
            className="mt-2 w-full rounded-lg border border-edge px-3 py-2 text-sm focus:border-brand-500 focus:outline-none"
          />
        </div>

        <div className="mt-5 flex flex-wrap items-center gap-3">
          <button
            onClick={() => {
              if (goals.length === 0) {
                setNudge(true);
                document.getElementById('goal-grid')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
                return;
              }
              build();
            }}
            aria-disabled={goals.length === 0}
            className={`btn-primary inline-flex items-center gap-2 ${goals.length === 0 ? 'opacity-60' : ''}`}
          >
            {hasPlan ? 'Update my plan' : 'Build my plan'} <ArrowRight size={16} aria-hidden />
          </button>
          {goals.length === 0 && (
            <span className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition ${nudge ? 'bg-amber-100 dark:bg-amber-500/15 text-amber-800 dark:text-amber-300' : 'text-amber-600 dark:text-amber-400'}`}>
              <ArrowUp size={15} aria-hidden /> Pick at least one goal above to continue.
            </span>
          )}
        </div>
      </section>
    );
  }

  // ── Plan ────────────────────────────────────────────────────────────────────
  const canPersonalise = (plan.freeText || '').trim().length > 0 && !plan.aiRefined;
  const { complete } = progress;
  return (
    <section className="mt-8" data-tour="pathway">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-lg font-bold text-heading">Your plan</h2>
          <p className="mt-1 text-sm text-muted">
            {plan.aiRefined ? 'Personalised for what you told us. ' : ''}Your north star — keep chipping away.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {canPersonalise && (
            <button
              onClick={personalise}
              disabled={enriching}
              className="inline-flex items-center gap-1.5 rounded-lg bg-brand-50 dark:bg-brand-500/10 px-3 py-1.5 text-sm font-semibold text-brand-700 dark:text-brand-300 hover:bg-brand-100 dark:hover:bg-brand-500/15 disabled:opacity-60"
            >
              <Wand2 size={15} aria-hidden /> {enriching ? 'Personalising…' : 'Personalise with AI · 2 credits'}
            </button>
          )}
          <button onClick={startEdit} className="text-sm font-medium text-brand-600 dark:text-brand-400 hover:text-brand-700 dark:hover:text-brand-300">Edit goals</button>
          <button onClick={reset} title="Start over" className="grid h-8 w-8 place-items-center rounded-lg text-faint hover:bg-sunken hover:text-dim">
            <RotateCcw size={15} aria-hidden />
          </button>
        </div>
      </div>

      {/* The progress bar and the ordered step list deliberately DON'T live here:
          the plan strip under the top nav (PlanBreadcrumb) carries both on every
          page, so repeating them on the dashboard was pure duplication. The
          completion state stays — the strip hides itself once the plan is done,
          and this is the only place a new goal can be set from. */}
      {complete && (
        <div className="mt-4 rounded-xl border border-line bg-surface p-4">
          <div className="flex items-center gap-2 text-green-700 dark:text-green-300">
            <PartyPopper size={18} aria-hidden />
            <span className="font-semibold">Plan complete — nice work! </span>
            <button onClick={reset} className="text-sm font-semibold text-brand-600 dark:text-brand-400 hover:text-brand-700 dark:hover:text-brand-300">Set a new goal →</button>
          </div>
        </div>
      )}

      {/* Tier-locked but relevant */}
      {plan.locked.length > 0 && (
        <div className="mt-4 rounded-xl border border-dashed border-line p-4">
          <h3 className="flex items-center gap-1.5 text-sm font-semibold text-dim"><Lock size={14} aria-hidden /> Unlocks on a higher plan</h3>
          <ul className="mt-2 space-y-1.5">
            {plan.locked.map((s) => (
              <li key={s.toolId} className="flex items-center justify-between gap-3 text-sm">
                <span className="text-dim"><span className="font-medium text-strong">{stepLabel(s)}</span> — {s.why}</span>
                <span className="shrink-0 rounded-full bg-amber-100 dark:bg-amber-500/15 px-2 py-0.5 text-[11px] font-bold uppercase text-amber-700 dark:text-amber-300">{PLANS[toolById(s.toolId).minTier].name}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Agentic "beyond the ask" suggestions */}
      {plan.extras.length > 0 && (
        <section className="mt-6">
          <h3 className="flex items-center gap-1.5 text-sm font-bold uppercase tracking-wide text-muted">
            <Sparkles size={14} aria-hidden /> Also worth doing
          </h3>
          <div className="dm-card-grid mt-3">
            {plan.extras.map((e) => {
              const key = e.toolId || e.action;
              const Icon = e.action ? Plug : Sparkles;
              return (
                <div key={key} className="card flex items-start gap-3 p-4">
                  <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-brand-50 dark:bg-brand-500/10 text-brand-600 dark:text-brand-400"><Icon size={18} aria-hidden /></span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-strong">{stepLabel(e)}</span>
                      {e.locked && <span className="rounded-full bg-amber-100 dark:bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-bold uppercase text-amber-700 dark:text-amber-300">{PLANS[toolById(e.toolId).minTier].name}</span>}
                    </div>
                    <p className="mt-0.5 text-sm text-muted">{e.why}</p>
                    <button onClick={() => go(e)} className="mt-2 text-sm font-semibold text-brand-600 dark:text-brand-400 hover:text-brand-700 dark:hover:text-brand-300">
                      {e.action ? 'Set up' : 'Open'} <ArrowRight size={13} className="inline" aria-hidden />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}
    </section>
  );
}
