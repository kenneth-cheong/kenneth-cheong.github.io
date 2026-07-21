import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Stethoscope, TrendingUp, PenLine, LineChart, Sparkles, Swords, BarChart3, ChevronRight, Zap, Search } from 'lucide-react';
import { GOALS, TOOLS, tierMeets } from '@shared/catalog.mjs';
import { useAuth } from '../context/AuthContext.jsx';
import Logo from './Logo.jsx';
import { startPlatformTour, markSeen } from '../lib/tours.js';

const GOAL_ICON = { TrendingUp, Stethoscope, PenLine, LineChart, Sparkles, Swords, BarChart3 };

// First-run welcome overlay. Sets intent (not just UI tour): greet → pick a
// goal (or the promoted one-click health check) → land on the right page with
// that goal active. Marks `welcomed` server-side so it shows exactly once,
// durably, across devices. Rendered by Layout; gated by needsWelcome(user).
export default function Welcome({ onDone }) {
  const { user, setOnboarding } = useAuth();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [wantsTour, setWantsTour] = useState(false);
  const first = user.name?.split(' ')[0] || 'there';
  const credits = (user.credits ?? 0).toLocaleString();

  // Persist welcomed (+ optional goal) then route. Don't await the network —
  // the optimistic local patch (and the localStorage mirror behind it) flips
  // `welcomed` immediately so we never flicker, and never re-ask if the write
  // fails.
  //
  // Also settles the platform tour here. The tour used to be offered by a
  // separate toast that slid in ~900ms after this dialog closed, which made the
  // welcome feel like the first of an endless queue. Now it's one checkbox on
  // this screen: either way the tour is marked seen server-side, so it never
  // nags again — it stays replayable from the "?" help menu.
  const finish = (goalId, to) => {
    if (busy) return;
    setBusy(true);
    setOnboarding({ welcomed: true, goal: goalId || null, seenPlatformTour: true });
    markSeen('platform');
    onDone?.();        // clears any ?welcome=1 force-open so the overlay closes
    navigate(to);
    if (wantsTour) setTimeout(startPlatformTour, 400); // let the route settle first
  };

  const pickGoal = (g) => finish(g.id, g.to || `/?goal=${g.id}`);

  // The promoted first action is tier-aware: the Site Health Check needs a paid
  // tier (its sub-tools are starter+), so free users would hit a paywall. Give
  // them Keyword Analysis instead — it runs on Free and pays off instantly.
  const canAudit = tierMeets(user.tier, 'starter');
  const hero = canAudit
    ? { icon: Stethoscope, goal: 'health', to: '/audit',
        title: 'Run a Site Health Check',
        body: 'One click checks your whole site — you get a score and a fix list, most important first.' }
    : { icon: Search, goal: 'visitors', to: '/tool/keyword-analysis',
        title: 'Find searches worth targeting',
        body: 'See how many people search a term, how hard it is to rank for, and what they’re after — free on your plan.' };
  const HeroIcon = hero.icon;

  return (
    <div className="fixed inset-0 z-[60] flex items-start justify-center overflow-y-auto bg-slate-900/50 p-4 backdrop-blur-sm sm:items-center">
      <div className="my-8 w-full max-w-2xl rounded-2xl border border-line bg-surface p-6 shadow-2xl sm:p-8">
        <div className="flex items-center gap-2 text-brand-600 dark:text-brand-400">
          <Logo width={140} />
          <span className="text-sm font-semibold uppercase tracking-wide text-faint">Welcome</span>
        </div>

        <h1 className="mt-4 text-2xl font-bold text-heading">Hi {first} — let’s get you a quick win.</h1>
        <p className="mt-1.5 text-dim">
          You’ve got <span className="font-semibold text-strong">{credits} credits</span> — the app’s currency for
          running its {TOOLS.length} tools: SEO (getting found on Google), content writing, and getting recommended
          by AI like ChatGPT. Pick a first move below — real results in a couple of minutes.
        </p>

        {/* Promoted first action — the strongest "aha" the user's tier can run. */}
        <button
          onClick={() => finish(hero.goal, hero.to)}
          disabled={busy}
          className="group mt-5 flex w-full items-center gap-4 rounded-xl border border-brand-300 dark:border-brand-500/40 bg-brand-50/70 dark:bg-brand-500/10 p-4 text-left transition hover:border-brand-400 hover:bg-brand-50 dark:hover:bg-brand-500/10 disabled:opacity-60"
        >
          <span className="grid h-11 w-11 shrink-0 place-items-center rounded-lg bg-brand-600 text-white"><HeroIcon size={22} aria-hidden /></span>
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-1.5 font-semibold text-heading">
              {hero.title} <ChevronRight size={16} className="text-brand-400 transition group-hover:translate-x-0.5" aria-hidden />
            </span>
            <span className="mt-0.5 block text-sm text-muted">{hero.body}</span>
          </span>
        </button>

        <div className="mt-6 mb-3 flex items-center gap-3">
          <span className="h-px flex-1 bg-overlay" />
          <span className="text-xs font-semibold uppercase tracking-wide text-faint">Or pick what you want to do first</span>
          <span className="h-px flex-1 bg-overlay" />
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          {GOALS.filter((g) => g.id !== hero.goal).map((g) => {
            const Icon = GOAL_ICON[g.icon] || Sparkles;
            return (
              <button
                key={g.id}
                onClick={() => pickGoal(g)}
                disabled={busy}
                className="group flex items-start gap-3 rounded-xl border border-line p-3 text-left transition hover:-translate-y-0.5 hover:border-brand-400 hover:shadow-lift disabled:opacity-60"
              >
                <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-brand-50 dark:bg-brand-500/10 text-brand-600 dark:text-brand-400"><Icon size={18} aria-hidden /></span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1 text-sm font-semibold text-strong">{g.label}</span>
                  <span className="mt-0.5 block text-xs text-muted">{g.desc}</span>
                </span>
              </button>
            );
          })}
        </div>

        {/* The tour offer, inline — not a second dialog queued behind this one. */}
        <label className="mt-6 flex cursor-pointer items-center gap-2.5 rounded-xl border border-line p-3 hover:border-brand-300 dark:hover:border-brand-500/40">
          <input
            type="checkbox"
            checked={wantsTour}
            onChange={(e) => setWantsTour(e.target.checked)}
            className="h-4 w-4 shrink-0 rounded border-edge text-brand-600 dark:text-brand-400 focus:ring-brand-500"
          />
          <span className="text-sm text-body">
            Show me around first — a 2-minute tour of the essentials.
            <span className="ml-1 text-muted">You can replay it anytime from the “?” button.</span>
          </span>
        </label>

        <div className="mt-5 flex items-center justify-between gap-3">
          <span className="inline-flex items-center gap-1.5 text-xs text-faint"><Zap size={13} aria-hidden /> You can change everything later — nothing here is locked in.</span>
          <button onClick={() => finish(null, '/')} disabled={busy} className="shrink-0 text-sm font-medium text-muted hover:text-strong disabled:opacity-60">
            Skip for now →
          </button>
        </div>
      </div>
    </div>
  );
}
