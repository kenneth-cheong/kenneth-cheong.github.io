import { Link } from 'react-router-dom';
import { Trophy, Zap, Target, Plug } from 'lucide-react';
import { PLANS } from '@shared/catalog.mjs';
import { useAuth } from '../context/AuthContext.jsx';
import { usePlan } from '../context/PlanContext.jsx';
import { stepLabel, stepTarget } from '../lib/planner.js';

// The approved design's attention strip (mockup .attn): a row of "here's what
// changed / what needs you" cards above the stats.
//
// Every card is CONDITIONAL on a real signal — if nothing is true, the strip
// renders nothing rather than padding itself out with filler. The mockup's
// "Weekly report is ready" card has no equivalent: there's no reports feature.
export default function AttentionStrip({ tracked, googleConnected, onUpgrade }) {
  const { user } = useAuth();
  const { hasPlan, progress } = usePlan();

  const max = PLANS[user.tier].monthlyCredits;
  const left = user.credits || 0;
  const renews = user.periodEnd
    ? new Date(user.periodEnd).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
    : null;

  const cards = [];

  // 1. Keywords that broke onto page 1 since the previous check — a real move,
  //    computed from the tracked keywords' own position history.
  const risers = (tracked || []).filter((t) => {
    const h = t.history || [];
    if (h.length < 2) return false;
    const now = h[h.length - 1]?.position;
    const before = h[h.length - 2]?.position;
    return typeof now === 'number' && now >= 1 && now <= 10 && typeof before === 'number' && before > 10;
  });
  if (risers.length) {
    cards.push({
      key: 'risers',
      icon: <Trophy size={17} aria-hidden />,
      hue: 'var(--c-pos)',
      title: `${risers.length} keyword${risers.length === 1 ? '' : 's'} hit page 1`,
      detail: risers.slice(0, 2).map((t) => `“${t.keyword}”`).join(' · '),
      cta: 'View',
      to: '/tracking',
    });
  }

  // 2. Running low on credits.
  if (left <= max * 0.2) {
    cards.push({
      key: 'credits',
      icon: <Zap size={17} aria-hidden />,
      hue: 'var(--c-warn)',
      title: `Only ${left.toLocaleString()} credit${left === 1 ? '' : 's'} left`,
      detail: renews ? `Resets ${renews}` : 'Top up to keep running tools',
      cta: 'Upgrade',
      onClick: onUpgrade,
    });
  }

  // 3. The next step of the user's actual plan.
  if (hasPlan && !progress.complete && progress.next) {
    cards.push({
      key: 'plan',
      icon: <Target size={17} aria-hidden />,
      hue: 'var(--c-peri)',
      title: `Up next: ${stepLabel(progress.next)}`,
      detail: `${progress.done} of ${progress.total} steps done`,
      cta: 'Open',
      to: stepTarget(progress.next).to,
    });
  }

  // 4. No Google data connected — the single biggest gap in what we can show.
  if (googleConnected === false) {
    cards.push({
      key: 'google',
      icon: <Plug size={17} aria-hidden />,
      hue: 'var(--c-peri)',
      title: 'Connect your Google data',
      detail: 'Search Console, GA4 & Ads in one place',
      cta: 'Connect',
      to: '/integrations',
    });
  }

  if (!cards.length) return null;

  return (
    <div className="mt-4 flex flex-wrap gap-3">
      {cards.slice(0, 3).map((c) => (
        <div key={c.key} className="card dm-lift flex min-w-[230px] flex-1 items-center gap-3 px-4 py-3.5">
          <span className="grid h-[34px] w-[34px] shrink-0 place-items-center rounded-[10px]"
            style={{ background: `rgb(${c.hue} / .16)`, color: `rgb(${c.hue})` }}>
            {c.icon}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-xs font-bold leading-snug text-heading">{c.title}</span>
            <span className="block truncate text-[10.5px] text-muted">{c.detail}</span>
          </span>
          {c.to ? (
            <Link to={c.to} className="shrink-0 rounded-[9px] bg-overlay px-3 py-1.5 text-[10.5px] font-extrabold tracking-wide text-heading transition-colors hover:bg-raised">
              {c.cta}
            </Link>
          ) : (
            <button type="button" onClick={c.onClick} className="shrink-0 rounded-[9px] bg-overlay px-3 py-1.5 text-[10.5px] font-extrabold tracking-wide text-heading transition-colors hover:bg-raised">
              {c.cta}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
