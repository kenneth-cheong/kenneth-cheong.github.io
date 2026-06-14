import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Stethoscope, TrendingUp, PenLine, LineChart, Sparkles, Swords, BarChart3, ChevronRight, Zap, Search } from 'lucide-react';
import { GOALS, TOOLS, tierMeets } from '@shared/catalog.mjs';
import { useAuth } from '../context/AuthContext.jsx';

const GOAL_ICON = { TrendingUp, Stethoscope, PenLine, LineChart, Sparkles, Swords, BarChart3 };

// First-run welcome overlay. Sets intent (not just UI tour): greet → pick a
// goal (or the promoted one-click health check) → land on the right page with
// that goal active. Marks `welcomed` server-side so it shows exactly once,
// durably, across devices. Rendered by Layout; gated by needsWelcome(user).
export default function Welcome({ onDone }) {
  const { user, setOnboarding } = useAuth();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const first = user.name?.split(' ')[0] || 'there';
  const credits = (user.credits ?? 0).toLocaleString();

  // Persist welcomed (+ optional goal) then route. Don't await the network —
  // the optimistic local patch flips `welcomed` immediately so we never flicker.
  const finish = (goalId, to) => {
    if (busy) return;
    setBusy(true);
    setOnboarding({ welcomed: true, goal: goalId || null });
    onDone?.();        // clears any ?welcome=1 force-open so the overlay closes
    navigate(to);
  };

  const pickGoal = (g) => finish(g.id, g.to || `/?goal=${g.id}`);

  // The promoted first action is tier-aware: the Site Health Check needs a paid
  // tier (its sub-tools are starter+), so free users would hit a paywall. Give
  // them Keyword Analysis instead — it runs on Free and pays off instantly.
  const canAudit = tierMeets(user.tier, 'starter');
  const hero = canAudit
    ? { icon: Stethoscope, goal: 'health', to: '/audit',
        title: 'Run a Site Health Check',
        body: 'One click → a scored report and a prioritised fix list for your site.' }
    : { icon: Search, goal: 'visitors', to: '/tool/keyword-analysis',
        title: 'Find keywords worth targeting',
        body: 'See search volume, difficulty and intent for any keyword — runs on your Free plan.' };
  const HeroIcon = hero.icon;

  return (
    <div className="fixed inset-0 z-[60] flex items-start justify-center overflow-y-auto bg-slate-900/50 p-4 backdrop-blur-sm sm:items-center">
      <div className="my-8 w-full max-w-2xl rounded-2xl border border-slate-200 bg-white p-6 shadow-2xl sm:p-8">
        <div className="flex items-center gap-2 text-brand-600">
          <span className="grid h-9 w-9 place-items-center rounded-lg bg-brand-600 text-lg font-bold text-white">D</span>
          <span className="text-sm font-semibold uppercase tracking-wide text-slate-400">Welcome to Digimetrics</span>
        </div>

        <h1 className="mt-4 text-2xl font-bold text-slate-900">Hi {first} — let’s get you a quick win.</h1>
        <p className="mt-1.5 text-slate-600">
          You’ve got <span className="font-semibold text-slate-800">{credits} credits</span> to explore {TOOLS.length} SEO,
          content &amp; AI-visibility tools. Pick a first move below — it takes a couple of minutes to see real results.
        </p>

        {/* Promoted first action — the strongest "aha" the user's tier can run. */}
        <button
          onClick={() => finish(hero.goal, hero.to)}
          disabled={busy}
          className="group mt-5 flex w-full items-center gap-4 rounded-xl border border-brand-300 bg-brand-50/70 p-4 text-left transition hover:border-brand-400 hover:bg-brand-50 disabled:opacity-60"
        >
          <span className="grid h-11 w-11 shrink-0 place-items-center rounded-lg bg-brand-600 text-white"><HeroIcon size={22} aria-hidden /></span>
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-1.5 font-semibold text-slate-900">
              {hero.title} <ChevronRight size={16} className="text-brand-400 transition group-hover:translate-x-0.5" aria-hidden />
            </span>
            <span className="mt-0.5 block text-sm text-slate-500">{hero.body}</span>
          </span>
        </button>

        <div className="mt-6 mb-3 flex items-center gap-3">
          <span className="h-px flex-1 bg-slate-200" />
          <span className="text-xs font-semibold uppercase tracking-wide text-slate-400">Or pick what you want to do first</span>
          <span className="h-px flex-1 bg-slate-200" />
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          {GOALS.filter((g) => g.id !== hero.goal).map((g) => {
            const Icon = GOAL_ICON[g.icon] || Sparkles;
            return (
              <button
                key={g.id}
                onClick={() => pickGoal(g)}
                disabled={busy}
                className="group flex items-start gap-3 rounded-xl border border-slate-200 p-3 text-left transition hover:-translate-y-0.5 hover:border-brand-400 hover:shadow-lift disabled:opacity-60"
              >
                <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-brand-50 text-brand-600"><Icon size={18} aria-hidden /></span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1 text-sm font-semibold text-slate-800">{g.label}</span>
                  <span className="mt-0.5 block text-xs text-slate-500">{g.desc}</span>
                </span>
              </button>
            );
          })}
        </div>

        <div className="mt-6 flex items-center justify-between">
          <span className="inline-flex items-center gap-1.5 text-xs text-slate-400"><Zap size={13} aria-hidden /> You can change everything later — nothing here is locked in.</span>
          <button onClick={() => finish(null, '/')} disabled={busy} className="text-sm font-medium text-slate-500 hover:text-slate-800 disabled:opacity-60">
            Skip for now →
          </button>
        </div>
      </div>
    </div>
  );
}
