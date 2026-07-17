import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Target, Check, ArrowRight, ChevronDown, ChevronUp, PartyPopper } from 'lucide-react';
import { usePlan } from '../context/PlanContext.jsx';
import { stepTarget, stepLabel } from '../lib/planner.js';

// Persist the expand/collapse choice so the panel doesn't fight the user. Starts
// COLLAPSED — the assistant is a chat first, so the docked plan stays a single
// "up next" row (a progress ring + the next step, mirroring the header pill)
// until the user expands it. That keeps Monty present-but-not-buried.
const LS_KEY = 'dm:planPanelExpanded';

// Compact progress ring with the done/total count in the centre — the same
// at-a-glance read the header pill uses, so the collapsed row needs neither a
// separate title nor a progress bar.
function MiniRing({ done, total }) {
  const r = 9;
  const c = 2 * Math.PI * r;
  const pct = total ? (done / total) * 100 : 0;
  return (
    <span className="relative grid h-6 w-6 shrink-0 place-items-center text-brand-600 dark:text-brand-400">
      <svg width="24" height="24" viewBox="0 0 24 24" className="-rotate-90" aria-hidden>
        <circle cx="12" cy="12" r={r} fill="none" stroke="currentColor" strokeOpacity="0.2" strokeWidth="2.5" />
        <circle cx="12" cy="12" r={r} fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"
          strokeDasharray={c} strokeDashoffset={c * (1 - pct / 100)} style={{ transition: 'stroke-dashoffset 500ms ease' }} />
      </svg>
      <span className="absolute text-[9px] font-bold tabular-nums leading-none">{done}/{total}</span>
    </span>
  );
}

// The north-star plan, docked at the top of the Assistant panel. The panel is
// open most of the time (it auto-opens on load), so this keeps "where am I / what
// next" in front of the user with far more room than the header chip. Reads the
// shared PlanContext, so it stays in lock-step with the dashboard + header widget.
export default function PlanPanelCard() {
  const { hasPlan, plan, progress, isStepDone, toggleDone } = usePlan();
  const navigate = useNavigate();
  const [expanded, setExpanded] = useState(() => localStorage.getItem(LS_KEY) === '1');
  const toggle = () => setExpanded((e) => { const n = !e; localStorage.setItem(LS_KEY, n ? '1' : '0'); return n; });
  // Navigate WITHOUT closing the panel — it's docked, and "keep both" means the
  // plan should stay put while the user works through a step.
  const goStep = (item) => navigate(stepTarget(item).to);

  // No plan yet → a quiet, tappable nudge to set one.
  if (!hasPlan) {
    return (
      <button
        onClick={() => navigate('/')}
        className="flex w-full items-center gap-2 border-b border-brand-100 dark:border-brand-500/25 bg-brand-50 dark:bg-brand-500/10 px-4 py-2.5 text-left hover:bg-brand-100 dark:hover:bg-brand-500/15"
      >
        <Target size={16} className="shrink-0 text-brand-600 dark:text-brand-400" aria-hidden />
        <span className="text-sm font-medium text-body">Set your goal for a step-by-step plan</span>
        <ArrowRight size={14} className="ml-auto shrink-0 text-brand-500" aria-hidden />
      </button>
    );
  }

  const { done, total, pct, complete, next } = progress;

  if (complete) {
    return (
      <div className="flex items-center gap-2 border-b border-green-100 dark:border-green-500/25 bg-green-50 dark:bg-green-500/10 px-4 py-3">
        <PartyPopper size={16} className="shrink-0 text-green-600 dark:text-green-400" aria-hidden />
        <span className="text-sm font-semibold text-green-800 dark:text-green-300">Plan complete — nice work!</span>
        <button onClick={() => navigate('/')} className="ml-auto shrink-0 rounded-lg bg-green-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-green-700">Set a new goal</button>
      </div>
    );
  }

  // Collapsed (default): a single compact row — ring + "up next" step + Start +
  // an expand chevron. One line, ~40px, so the docked plan barely touches the
  // chat below.
  if (!expanded) {
    return (
      <div className="flex items-center gap-2.5 border-b border-brand-100 dark:border-brand-500/25 bg-brand-50 dark:bg-brand-500/10 px-3 py-2">
        <button onClick={toggle} title="Show all steps" aria-expanded={false} className="shrink-0">
          <MiniRing done={done} total={total} />
        </button>
        <button onClick={() => next && goStep(next)} className="flex min-w-0 flex-1 flex-col items-start leading-tight text-left">
          <span className="text-[9px] font-bold uppercase tracking-wide text-brand-400">Up next</span>
          <span className="max-w-full truncate text-xs font-semibold text-strong">{next ? stepLabel(next) : 'Your plan'}</span>
        </button>
        {next && (
          <button onClick={() => goStep(next)} className="shrink-0 rounded-lg bg-brand-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-brand-700">
            Start <ArrowRight size={12} className="inline align-[-1px]" aria-hidden />
          </button>
        )}
        <button onClick={toggle} title="Show all steps" className="shrink-0 rounded p-0.5 text-faint hover:text-dim">
          <ChevronDown size={16} aria-hidden />
        </button>
      </div>
    );
  }

  // Expanded: the full checklist, with a title row + progress bar.
  return (
    <div className="border-b border-brand-100 dark:border-brand-500/25 bg-brand-50 dark:bg-brand-500/10">
      <button onClick={toggle} className="flex w-full items-center gap-2 px-4 pb-2 pt-2.5 text-left" aria-expanded={expanded} title="Collapse plan">
        <Target size={16} className="shrink-0 text-brand-600 dark:text-brand-400" aria-hidden />
        <span className="text-sm font-semibold text-strong">Your plan</span>
        <span className="ml-auto text-xs font-semibold tabular-nums text-brand-700 dark:text-brand-300">{done} / {total} done</span>
        <ChevronUp size={16} className="shrink-0 text-faint" aria-hidden />
      </button>

      <div className="px-4 pb-1">
        <div className="h-1.5 overflow-hidden rounded-full bg-brand-100 dark:bg-brand-500/15">
          <div className="h-full rounded-full bg-brand-600 transition-[width] duration-500" style={{ width: `${pct}%` }} />
        </div>
      </div>

      {/* Cap the list so a long plan scrolls inside the card instead of eating
          the whole panel — the chat thread below keeps its room either way. */}
      <ul className="max-h-[34vh] overflow-y-auto px-2 pb-3 pt-1.5">
          {plan.steps.map((s, i) => {
            const isDone = isStepDone(s);
            const isNext = !!next && s.toolId === next.toolId && !isDone;
            return (
              <li key={s.toolId}>
                <button
                  onClick={() => goStep(s)}
                  className={`flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-surface/70 ${isNext ? 'bg-surface ring-1 ring-brand-200' : ''}`}
                >
                  {/* Manual (recommendation) steps can't be auto-detected, so the
                      circle is a real tick toggle; tool steps just show status. */}
                  <span
                    role={s.manual ? 'checkbox' : undefined}
                    aria-checked={s.manual ? isDone : undefined}
                    onClick={s.manual ? (e) => { e.stopPropagation(); toggleDone(s.toolId); } : undefined}
                    title={s.manual ? (isDone ? 'Mark as not done' : 'Mark as done') : undefined}
                    className={`grid h-5 w-5 shrink-0 place-items-center rounded-full text-[11px] font-bold text-white ${isDone ? 'bg-green-500' : 'bg-brand-600'} ${s.manual ? 'cursor-pointer ring-offset-1 hover:ring-2 hover:ring-brand-300' : ''}`}
                  >
                    {isDone ? <Check size={12} aria-hidden /> : i + 1}
                  </span>
                  <span className={`flex-1 truncate text-xs ${isDone ? 'text-faint line-through' : isNext ? 'font-semibold text-strong' : 'text-dim'}`}>{stepLabel(s)}</span>
                  {!isDone && <ArrowRight size={13} className="shrink-0 text-slate-300" aria-hidden />}
                </button>
              </li>
            );
          })}
      </ul>
    </div>
  );
}
