import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { PLANS, TOOLS, tierMeets } from '@shared/catalog.mjs';
import { useAuth } from '../context/AuthContext.jsx';
import PeekMascot from './PeekMascot.jsx';

// The approved design's welcome hero (mockup .banner): a periwinkle slab with a
// greeting, an upgrade pitch and two CTAs.
//
// The mockup's copy is "You're on the Pro Trial with 3 days left" — the account
// model has NO trial fields, so that sentence can't be told truthfully. This
// speaks to the real tier instead: what you're on, and what the next tier up
// actually gives you (real names, real credit allowances).
//
// The palette is fixed rather than tokenised, exactly as in the mockup: it's a
// light periwinkle slab with dark ink in all three themes.
const KEY = 'dm:bannerDismissed';

export default function WelcomeBanner({ onShowTools, onUpgrade }) {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [gone, setGone] = useState(() => localStorage.getItem(KEY) === '1');
  if (gone) return null;

  const plan = PLANS[user.tier];
  // The cheapest tier above the current one — what "upgrade" concretely means.
  const next = Object.values(PLANS).find((p) => !tierMeets(user.tier, p.id) && p.id !== user.tier);
  const locked = TOOLS.filter((t) => !tierMeets(user.tier, t.minTier)).length;

  const dismiss = () => { setGone(true); localStorage.setItem(KEY, '1'); };

  return (
    <div
      className="relative mt-2 flex min-h-[192px] flex-col justify-center gap-2.5 overflow-hidden rounded-[22px] px-9 py-8"
      style={{ background: 'linear-gradient(115deg,#c3ceff 0%,#9fb0ff 100%)', color: '#0d2a5e', boxShadow: 'var(--e-shadow)' }}
    >
      <div className="text-[15px] font-bold tracking-tight">Welcome</div>
      <h1 className="text-[27px] font-extrabold leading-[1.1] tracking-tight">{user.name?.split(' ')[0] || 'there'}</h1>
      <p className="max-w-[44ch] text-xs font-medium leading-relaxed" style={{ color: 'rgba(9,35,80,.78)' }}>
        {next ? (
          <>
            You're on {plan.name}. Upgrade to {next.name} to unlock{' '}
            <button
              type="button"
              onClick={onShowTools}
              className="font-bold"
              style={{ color: '#1b2fd6', borderBottom: '1px solid rgba(27,47,214,.4)' }}
            >
              {locked > 0 ? `${locked} more tools` : `all ${TOOLS.length} tools`}
            </button>{' '}
            and {next.monthlyCredits.toLocaleString()} AI credits every month.
          </>
        ) : (
          <>
            You're on {plan.name} — every one of the {TOOLS.length} tools is unlocked, with{' '}
            {plan.monthlyCredits.toLocaleString()} AI credits a month.
          </>
        )}
      </p>
      <div className="mt-2 flex gap-3">
        {next ? (
          <>
            <button
              type="button"
              onClick={onUpgrade}
              className="rounded-[22px] border-none bg-white px-6 py-3 text-[10px] font-extrabold tracking-[0.14em] transition-colors hover:bg-[#e8ecff]"
              style={{ color: '#1b2fd6' }}
            >
              BECOME {next.name.toUpperCase()}
            </button>
            <button
              type="button"
              onClick={dismiss}
              className="rounded-[22px] bg-transparent px-6 py-3 text-[10px] font-extrabold tracking-[0.14em] transition-colors"
              style={{ color: '#0d2a5e', border: '1.5px solid rgba(9,35,80,.45)' }}
            >
              NO THANKS
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={() => navigate('/usage')}
            className="rounded-[22px] border-none bg-white px-6 py-3 text-[10px] font-extrabold tracking-[0.14em] transition-colors hover:bg-[#e8ecff]"
            style={{ color: '#1b2fd6' }}
          >
            VIEW USAGE
          </button>
        )}
      </div>

      {/* The mockup parks a photo of a success specialist here. Otter — one of
          Monty's friends — takes the slot instead, peeking over the banner's
          bottom edge and waving. Decorative; the wrapper carries the mockup's
          drop-shadow and the peek offset. */}
      <span
        className="pointer-events-none absolute -bottom-2 right-8 hidden select-none sm:block"
        style={{ filter: 'drop-shadow(-10px 12px 22px rgba(4,30,60,.35))' }}
        aria-hidden
      >
        <PeekMascot name="otter" width={210} /></span>
    </div>
  );
}
