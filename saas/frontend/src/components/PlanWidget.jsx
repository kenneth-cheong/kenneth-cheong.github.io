import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Target, Check, ArrowRight, PartyPopper } from 'lucide-react';
import { usePlan } from '../context/PlanContext.jsx';
import { stepTarget, stepLabel } from '../lib/planner.js';

// Small SVG progress ring shown inside the header pill. The number/check in the
// centre gives an at-a-glance read of how far along the plan is; the coloured arc
// fills as steps complete. Colours flip to white when the pill is open (active).
function Ring({ pct, done, total, complete, active }) {
  const r = 8;
  const c = 2 * Math.PI * r;
  const track = active ? 'rgba(255,255,255,0.35)' : 'rgba(0,0,0,0.10)';
  const arc = active ? '#fff' : complete ? '#16a34a' : 'currentColor';
  return (
    <span className="relative grid h-6 w-6 shrink-0 place-items-center">
      <svg width="24" height="24" viewBox="0 0 24 24" className="-rotate-90" aria-hidden>
        <circle cx="12" cy="12" r={r} fill="none" stroke={track} strokeWidth="2.5" />
        <circle
          cx="12" cy="12" r={r} fill="none" stroke={arc} strokeWidth="2.5" strokeLinecap="round"
          strokeDasharray={c} strokeDashoffset={c * (1 - pct / 100)}
          style={{ transition: 'stroke-dashoffset 500ms ease' }}
        />
      </svg>
      <span className="absolute grid place-items-center">
        {complete
          ? <Check size={12} strokeWidth={3} aria-hidden />
          : <span className="text-[10px] font-bold tabular-nums leading-none">{done}/{total}</span>}
      </span>
    </span>
  );
}

// The always-visible "north star": a compact progress button in the header that
// expands into the plan checklist, so the user's goal pathway follows them onto
// every page — not just the dashboard. Reads the shared PlanContext, so progress
// stays in lock-step with the dashboard planner and syncs across devices.
export default function PlanWidget() {
  const { hasPlan, plan, progress, isStepDone } = usePlan();
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const navigate = useNavigate();

  useEffect(() => {
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  // No plan yet → a brand-tinted nudge to set one. Tinted (not grey) so it reads
  // as a call to action next to the neutral meters, keeping the north star
  // discoverable rather than hidden.
  if (!hasPlan) {
    return (
      <button
        onClick={() => navigate('/')}
        title="Set your goal and get a step-by-step plan"
        className="hidden items-center gap-1.5 rounded-lg border border-brand-200 dark:border-brand-500/30 bg-brand-50 dark:bg-brand-500/10 px-2.5 py-1.5 text-sm font-semibold text-brand-700 dark:text-brand-300 hover:bg-brand-100 dark:hover:bg-brand-500/15 sm:inline-flex"
      >
        <Target size={16} aria-hidden /><span className="hidden lg:inline">Set a goal</span>
      </button>
    );
  }

  const { done, total, pct, complete, next } = progress;
  const go = (item) => { setOpen(false); navigate(stepTarget(item).to); };

  return (
    <div ref={ref} className="relative">
      {/* Brand-tinted pill with a progress ring + the NAME of the next step, so
          "what do I do next" is legible in the header itself — not a bare count
          that blends into the neighbouring credit/notification chips. */}
      <button
        onClick={() => setOpen((o) => !o)}
        title={complete ? 'Your plan — all done' : next ? `Up next: ${stepLabel(next)}` : 'Your plan'}
        className={`inline-flex items-center gap-2 rounded-lg border px-2 py-1 text-sm font-semibold transition-colors ${
          open
            ? 'border-brand-600 bg-brand-600 text-white'
            : complete
              ? 'border-green-200 dark:border-green-500/30 bg-green-50 dark:bg-green-500/10 text-green-700 dark:text-green-300 hover:bg-green-100 dark:hover:bg-green-500/15'
              : 'border-brand-200 dark:border-brand-500/30 bg-brand-50 dark:bg-brand-500/10 text-brand-700 dark:text-brand-300 hover:bg-brand-100 dark:hover:bg-brand-500/15'
        }`}
      >
        <Ring pct={pct} done={done} total={total} complete={complete} active={open} />
        {complete ? (
          <span className="flex items-center gap-1 pr-0.5">
            <PartyPopper size={14} aria-hidden />
            <span className="hidden md:inline">Plan complete</span>
          </span>
        ) : (
          <span className="hidden min-w-0 flex-col items-start leading-tight lg:flex">
            <span className={`text-[9px] font-bold uppercase tracking-wide ${open ? 'text-white/70' : 'text-brand-400'}`}>Up next</span>
            <span className="max-w-[9rem] truncate text-xs font-semibold">{next ? stepLabel(next) : 'Your plan'}</span>
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 z-40 mt-2 w-80 overflow-hidden rounded-xl border border-line bg-surface shadow-xl">
          <div className="border-b border-hair px-4 py-3">
            <div className="flex items-center justify-between">
              <span className="text-sm font-semibold text-strong">Your plan</span>
              <button onClick={() => { setOpen(false); navigate('/'); }} className="text-xs font-medium text-brand-600 dark:text-brand-400 hover:text-brand-700 dark:hover:text-brand-300">Open →</button>
            </div>
            <div className="mt-2 h-2 overflow-hidden rounded-full bg-sunken">
              <div className="h-full rounded-full bg-brand-600 transition-[width] duration-500" style={{ width: `${pct}%` }} />
            </div>
            <div className="mt-1.5 text-xs text-muted">
              {complete ? '🎉 All done — set a new goal on the dashboard.' : next ? <>Up next: <span className="font-medium text-body">{stepLabel(next)}</span></> : `${done} of ${total} done`}
            </div>
          </div>
          <ul className="max-h-80 overflow-y-auto py-1">
            {plan.steps.map((s, i) => {
              const isDone = isStepDone(s);
              return (
                <li key={s.toolId}>
                  <button onClick={() => go(s)} className="flex w-full items-center gap-3 px-4 py-2 text-left hover:bg-raised">
                    <span className={`grid h-5 w-5 shrink-0 place-items-center rounded-full text-[11px] font-bold text-white ${isDone ? 'bg-green-500' : 'bg-brand-600'}`}>
                      {isDone ? <Check size={12} aria-hidden /> : i + 1}
                    </span>
                    <span className={`flex-1 truncate text-sm ${isDone ? 'text-faint line-through' : 'text-body'}`}>{stepLabel(s)}</span>
                    {!isDone && <ArrowRight size={13} className="shrink-0 text-slate-300" aria-hidden />}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
