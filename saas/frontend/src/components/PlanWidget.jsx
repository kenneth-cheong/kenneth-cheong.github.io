import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Target, Check, ArrowRight, PartyPopper } from 'lucide-react';
import { usePlan } from '../context/PlanContext.jsx';
import { stepTarget, stepLabel } from '../lib/planner.js';

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

  // No plan yet → a quiet nudge to set one (keeps the north star discoverable).
  if (!hasPlan) {
    return (
      <button
        onClick={() => navigate('/')}
        title="Set your goal and get a step-by-step plan"
        className="hidden items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm font-medium text-slate-500 hover:bg-slate-100 hover:text-slate-700 sm:inline-flex"
      >
        <Target size={16} aria-hidden /><span className="hidden lg:inline">Set a goal</span>
      </button>
    );
  }

  const { done, total, pct, complete, next } = progress;
  const go = (item) => { setOpen(false); navigate(stepTarget(item).to); };

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        title="Your plan"
        className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm font-semibold ${open ? 'bg-brand-600 text-white' : 'bg-slate-100 text-slate-700 hover:bg-slate-200'}`}
      >
        {complete ? <PartyPopper size={16} aria-hidden /> : <Target size={16} aria-hidden />}
        <span className="tabular-nums">{done}/{total}</span>
      </button>

      {open && (
        <div className="absolute right-0 z-40 mt-2 w-80 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-xl">
          <div className="border-b border-slate-100 px-4 py-3">
            <div className="flex items-center justify-between">
              <span className="text-sm font-semibold text-slate-800">Your plan</span>
              <button onClick={() => { setOpen(false); navigate('/'); }} className="text-xs font-medium text-brand-600 hover:text-brand-700">Open →</button>
            </div>
            <div className="mt-2 h-2 overflow-hidden rounded-full bg-slate-100">
              <div className="h-full rounded-full bg-brand-600 transition-[width] duration-500" style={{ width: `${pct}%` }} />
            </div>
            <div className="mt-1.5 text-xs text-slate-500">
              {complete ? '🎉 All done — set a new goal on the dashboard.' : next ? <>Up next: <span className="font-medium text-slate-700">{stepLabel(next)}</span></> : `${done} of ${total} done`}
            </div>
          </div>
          <ul className="max-h-80 overflow-y-auto py-1">
            {plan.steps.map((s, i) => {
              const isDone = isStepDone(s);
              return (
                <li key={s.toolId}>
                  <button onClick={() => go(s)} className="flex w-full items-center gap-3 px-4 py-2 text-left hover:bg-slate-50">
                    <span className={`grid h-5 w-5 shrink-0 place-items-center rounded-full text-[11px] font-bold text-white ${isDone ? 'bg-green-500' : 'bg-brand-600'}`}>
                      {isDone ? <Check size={12} aria-hidden /> : i + 1}
                    </span>
                    <span className={`flex-1 truncate text-sm ${isDone ? 'text-slate-400 line-through' : 'text-slate-700'}`}>{stepLabel(s)}</span>
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
