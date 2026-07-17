import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Clock, Check } from 'lucide-react';
import { GOALS, toolById, explorerProgress } from '@shared/catalog.mjs';
import { useAuth } from '../context/AuthContext.jsx';
import { useProjects } from '../context/ProjectContext.jsx';
import { api } from '../lib/api.js';
import ToolCard from '../components/ToolCard.jsx';
import ProfilePrompt from '../components/ProfilePrompt.jsx';
import GoalPlanner from '../components/GoalPlanner.jsx';
import ExplorerCard from '../components/ExplorerCard.jsx';
import Cockpit from '../components/Cockpit.jsx';
import DailyFocus from '../components/DailyFocus.jsx';
import WelcomeBanner from '../components/WelcomeBanner.jsx';
import PostUsageSurvey from '../components/PostUsageSurvey.jsx';
import ExitMicroSurvey from '../components/ExitMicroSurvey.jsx';
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

export default function Dashboard() {
  const { user, setOnboarding } = useAuth();
  const { projects } = useProjects();
  const [params, setParams] = useSearchParams();
  const [plannerGoal, setPlannerGoal] = useState(null); // goal id deep-linked from the welcome flow
  const [googleConnected, setGoogleConnected] = useState(false);

  // Arriving from the welcome flow with ?goal=<id> → open Simple mode and hand
  // the goal to the planner as a starting selection, then strip the param so a
  // refresh doesn't re-pin it. Keyed on the param value (not mount) because the
  // dashboard is already mounted under the welcome overlay when it navigates
  // here, so a mount-only effect never fires.
  const goalParam = params.get('goal');
  useEffect(() => {
    if (goalParam && GOALS.some((x) => x.id === goalParam)) {
      setPlannerGoal(goalParam);
      const next = new URLSearchParams(params); next.delete('goal'); setParams(next, { replace: true });
    }
  }, [goalParam]); // eslint-disable-line react-hooks/exhaustive-deps

  const [showOnboard, setShowOnboard] = useState(() => !user.onboarding?.dismissedChecklist && localStorage.getItem('dm_onboard_done') !== '1');
  const dismissOnboard = () => { setShowOnboard(false); localStorage.setItem('dm_onboard_done', '1'); setOnboarding({ dismissedChecklist: true }); };
  // Sequence the nudges: a brand-new Simple-mode user used to face the setup
  // checklist + GoalPlanner + profile prompt all at once. Now the goal planner
  // leads alone; the checklist and profile prompt wait until there's been a
  // first run (or the user opts into Advanced mode, where the planner is gone).
  // ...but "has run something" can't come from localStorage alone: recents live in
  // one browser, so a cleared/other device reads zero runs and permanently retires
  // both nudges for an account that's actually active. Fall back to the server's
  // run history, and only when the local list is empty (the common case pays nothing).
  const [ranBefore, setRanBefore] = useState(false);
  const everRan = getRecent().length > 0 || ranBefore;
  useEffect(() => {
    if (getRecent().length) return;
    api.runs().then((d) => setRanBefore((d.runs || []).length > 0)).catch(() => {});
  }, []);
  useEffect(() => { api.integrations().then((d) => setGoogleConnected(Object.values(d.connected || {}).some((c) => c?.connected))).catch(() => {}); }, []);

  // Has the user finished the Explorer "essentials"? Gates the post-usage NPS
  // survey (an "earned an opinion" moment). Same shared engine the card uses.
  const explorerCoreComplete = explorerProgress({
    tier: user.tier,
    ranTools: getRecent(),
    hasProject: projects.length > 0,
    hasGoogle: googleConnected,
    done: user.onboarding?.explorer?.done || {},
  }).coreComplete;

  const recent = getRecent().map(toolById).filter(Boolean);
  const Card = (t) => <ToolCard key={t.id} tool={t} userTier={user.tier} />;

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
      <div>
        <h1 className="text-2xl font-bold">Welcome back, {user.name?.split(' ')[0] || 'there'}</h1>
        <p className="mt-1 text-dim">Here's how your sites are doing today.</p>
      </div>

      {/* One clear next action, chosen from the user's real state — the daily
          return hook. Self-hides once dismissed for the day. */}
      <DailyFocus googleConnected={googleConnected} />

      {/* Cockpit — the approved design's stat row, activity chart and credit
          gauge. Real account data only; see Cockpit.jsx. */}
      {(
        <WelcomeBanner
          onShowTools={() => window.dispatchEvent(new CustomEvent('dm:open-tools'))}
          onUpgrade={() => window.dispatchEvent(new CustomEvent('dm:open-plan'))}
        />
      )}
      <Cockpit googleConnected={googleConnected} />

      {/* Onboarding checklist (until all done or dismissed; deferred until a
          first run so it never stacks on the goal planner for a new user) */}
      {showOnboard && !allDone && everRan && (
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

      {/* Progressive-profiling nudge — self-hides when complete/rewarded/snoozed.
          Held back until the user has run something: earn value before asking. */}
      {everRan && <ProfilePrompt />}

      {/* Breadth checklist — steers trial users across every discipline (and pays
          bonus credits). Self-hides once fully claimed or dismissed. */}
      <ExplorerCard googleConnected={googleConnected} projects={projects} />

      {/* Post-usage NPS questionnaire — shown once the user has earned an opinion. */}
      <PostUsageSurvey coreComplete={explorerCoreComplete} />

      {/* Exit micro-survey — self-gating idle nudge for stalled, low-engagement users. */}
      <ExitMicroSurvey />

      {/* The goal planner — the mockup's "AI Custom Plan". Always on now: it
          used to be gated behind Simple mode, whose only alternative was the
          tool grid that has since moved to the rail's catalog popup. */}
      <GoalPlanner initialGoal={plannerGoal} />

      {/* A shortcut, not a catalog — the popup doesn't surface recents. */}
      {recent.length > 0 && (
        <Section title="Recently used" icon={<Clock size={14} aria-hidden />}>{recent.map((t) => Card(t))}</Section>
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

// Section heading in the approved design's `.lab` style: a small, widely
// letterspaced, faint uppercase label rather than a competing sub-heading.
function Section({ title, icon, children }) {
  return (
    <section className="mt-8">
      <h2 className="mb-3 flex items-center gap-2 text-[10px] font-bold uppercase tracking-[0.18em] text-faint">{icon}{title}</h2>
      <div className="dm-card-grid">{children}</div>
    </section>
  );
}
