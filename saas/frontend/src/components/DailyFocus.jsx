import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Flame, ArrowRight, FolderPlus, Plug, Target, Zap, PartyPopper } from 'lucide-react';
import { PLANS } from '@shared/catalog.mjs';
import { useAuth } from '../context/AuthContext.jsx';
import { useProjects } from '../context/ProjectContext.jsx';
import { api } from '../lib/api.js';

// "One thing to do today" — the single highest-value next action, chosen from
// the user's real state (projects, Google connection, tracked keywords, credits,
// whether they've run anything today). Replaces "scan a wall of cards and decide"
// with one clear move, and celebrates the streak so returning daily feels earned.
//
// Dismissible for the day (never nags twice). Purely a router over things that
// already exist — navigation + the dm:open-tools event.

const DAY = 86400000;
const startOfDay = (t) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
const todayKey = () => new Date().toISOString().slice(0, 10);

function streakFrom(days) {
  const today = startOfDay(Date.now());
  if (!days.has(today) && !days.has(today - DAY)) return 0;
  let n = 0;
  for (let d = days.has(today) ? today : today - DAY; days.has(d); d -= DAY) n++;
  return n;
}

// Goal → the concrete first move for that goal (mirrors the dashboard's steps).
const GOAL_ACTION = {
  visitors: { title: 'Find keywords worth chasing', body: 'See volume & difficulty for terms you want to rank for.', tool: 'keyword-analysis' },
  content: { title: 'Draft a piece that ranks', body: 'Turn a topic into an optimised post or caption.', tool: 'content-writer' },
  'ai-visibility': { title: 'Check your AI visibility', body: 'See whether ChatGPT, Gemini & Perplexity cite you.', tool: 'ai-discovery' },
  competitors: { title: 'Size up a competitor', body: 'See who you are up against and where the gaps are.', tool: 'competitors' },
  health: { title: 'Run a site health check', body: 'Get a scored report and a prioritised fix list.', to: '/audit' },
  rankings: { title: 'Track a keyword', body: 'Watch a keyword’s Google position over time.', to: '/tracking' },
  'my-data': { title: 'Connect your Google data', body: 'Pull Search Console, Analytics & Ads into one view.', to: '/integrations' },
};

export default function DailyFocus({ googleConnected = false }) {
  const { user } = useAuth();
  const { projects, activeId } = useProjects();
  const navigate = useNavigate();
  const [runs, setRuns] = useState(null);
  const [tracked, setTracked] = useState(null);
  const [gone, setGone] = useState(() => localStorage.getItem('dm:focusDone') === todayKey());

  useEffect(() => { api.runs().then((d) => setRuns(d.runs || [])).catch(() => setRuns([])); }, []);
  useEffect(() => { api.tracking(activeId).then((d) => setTracked(d.tracked || [])).catch(() => setTracked([])); }, [activeId]);

  const dismiss = () => { setGone(true); localStorage.setItem('dm:focusDone', todayKey()); };

  const { streak, ranToday } = useMemo(() => {
    const days = new Set((runs || []).map((r) => startOfDay(new Date(r.ts).getTime())));
    return { streak: streakFrom(days), ranToday: days.has(startOfDay(Date.now())) };
  }, [runs]);

  const trackedCount = (tracked || []).length;
  const max = PLANS[user.tier]?.monthlyCredits || 0;
  const left = user.credits || 0;
  const lowCredits = max > 0 && left <= Math.max(5, Math.round(max * 0.08));

  // The priority ladder — first match wins.
  const focus = useMemo(() => {
    if (!projects.length) return { icon: FolderPlus, tag: 'Set up', title: 'Create your first project', body: 'Group a site’s runs, keywords and data in one place.', cta: 'New project', act: () => navigate('/projects') };
    if (!googleConnected) return { icon: Plug, tag: 'Set up', title: 'Connect your Google data', body: 'Pull Search Console, Analytics & Ads so every tool sees your real numbers.', cta: 'Connect', act: () => navigate('/integrations') };
    if (trackedCount === 0) return { icon: Target, tag: 'Get value', title: 'Track your first keyword', body: 'Pick a term that matters and watch its Google position over time.', cta: 'Track one', act: () => navigate('/tracking') };
    if (lowCredits) return { icon: Zap, tag: 'Heads up', tone: 'warn', title: 'You’re low on AI credits', body: `${left.toLocaleString()} left this cycle. Top up so runs don’t stall mid-task.`, cta: 'Top up', act: () => navigate('/account') };
    if (!ranToday) {
      const g = GOAL_ACTION[user.onboarding?.goal] || { title: 'Run today’s check', body: 'One quick run keeps your data — and your streak — fresh.', tool: 'keyword-analysis' };
      const act = g.to ? () => navigate(g.to) : () => navigate(`/tool/${g.tool}`);
      return { icon: Flame, tag: streak > 0 ? `Keep your ${streak}-day streak` : 'Today', title: g.title, body: g.body, cta: 'Do it', act };
    }
    return { icon: PartyPopper, tone: 'good', tag: 'All caught up', title: streak > 1 ? `You’re on a ${streak}-day roll` : 'You’re set for today', body: 'Nice work. Explore a tool you haven’t tried, or line up more keywords to track.', cta: 'Explore tools', act: () => window.dispatchEvent(new CustomEvent('dm:open-tools')) };
  }, [projects.length, googleConnected, trackedCount, lowCredits, ranToday, streak, left, user.onboarding?.goal, navigate]);

  // Wait for the data the ladder depends on, so we never flash a wrong step.
  if (gone || runs === null || tracked === null) return null;

  const Icon = focus.icon;
  const tone = focus.tone === 'good' ? 'pos' : focus.tone === 'warn' ? 'warn' : 'brand';

  return (
    <section className="dm-focus mt-4" data-tone={tone} aria-label="Your focus for today">
      <span className="dm-focus-glow" aria-hidden />
      <div className="relative flex flex-wrap items-center gap-4">
        <span className="dm-focus-ic grid h-12 w-12 shrink-0 place-items-center rounded-2xl">
          <Icon size={22} aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-[10px] font-bold uppercase tracking-[0.16em] text-faint">{focus.tag}</span>
            {streak > 0 && (
              <span className="inline-flex items-center gap-1 rounded-full bg-orange-100 px-2 py-0.5 text-[10px] font-bold text-orange-600 dark:bg-orange-500/15 dark:text-orange-300">
                <Flame size={11} aria-hidden /> {streak}-day streak
              </span>
            )}
          </div>
          <h2 className="mt-0.5 text-lg font-bold leading-tight text-heading">{focus.title}</h2>
          <p className="mt-0.5 text-sm text-muted">{focus.body}</p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => { focus.act(); }} className="inline-flex items-center gap-1.5 rounded-xl bg-brand-600 px-4 py-2.5 text-sm font-bold text-white hover:bg-brand-700">
            {focus.cta} <ArrowRight size={15} aria-hidden />
          </button>
          <button onClick={dismiss} className="rounded-lg px-2 py-2 text-xs font-medium text-faint hover:text-body" title="Hide until tomorrow">Later</button>
        </div>
      </div>
    </section>
  );
}
