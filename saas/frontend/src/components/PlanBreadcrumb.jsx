import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Target, Check, ArrowRight, ChevronDown, ChevronUp, X } from 'lucide-react';
import { usePlan } from '../context/PlanContext.jsx';
import { stepTarget, stepLabel } from '../lib/planner.js';
import { usePlanStripDismissed } from '../lib/planStrip.js';

// A slim, full-width progress strip that sits under the top nav on EVERY page,
// including the dashboard — so the plan's "what next" is a constant anchor no
// matter where the user is. Deliberately one row tall so it never crowds the
// page; the step list is an opt-in expand.
//
// Hidden only where it would be noise: once the plan is complete, when there's
// no plan, and after a per-session dismiss — so a user who wants it gone gets a
// quiet app back until next visit. The dismiss is recoverable: it flips a shared
// flag (see lib/planStrip.js) that makes the header show a "Show plan" chip, so
// hiding the strip is never a one-way door.
export default function PlanBreadcrumb() {
  const { hasPlan, plan, progress, isStepDone } = usePlan();
  const navigate = useNavigate();
  const [expanded, setExpanded] = useState(false);
  const [dismissed, setDismissed] = usePlanStripDismissed();

  if (dismissed || !hasPlan || progress.complete) return null;

  const { done, total, pct, next } = progress;
  const go = (item) => navigate(stepTarget(item).to);

  return (
    <div className="border-t border-hair bg-brand-50/60 dark:bg-brand-500/[0.07]">
      <div className="mx-auto flex max-w-6xl items-center gap-3 px-4 py-2">
        <Target size={15} className="hidden shrink-0 text-brand-600 dark:text-brand-400 sm:block" aria-hidden />

        {/* The headline: what to do next, legible inline. Clicking it jumps in. */}
        <button
          onClick={() => next && go(next)}
          disabled={!next}
          className="flex min-w-0 items-center gap-1.5 text-left text-sm text-dim disabled:cursor-default"
          title={next ? `Up next: ${stepLabel(next)}` : 'Your plan'}
        >
          <span className="hidden shrink-0 font-medium text-brand-700 dark:text-brand-300 sm:inline">Up next:</span>
          <span className="truncate font-semibold text-strong">{next ? stepLabel(next) : 'Your plan'}</span>
        </button>

        {/* A thin progress read + count, pushed to the right so the strip scans
            left-to-right as "next step ……… how far along". */}
        <div className="ml-auto flex shrink-0 items-center gap-2.5">
          <div className="hidden h-1.5 w-24 overflow-hidden rounded-full bg-brand-100 dark:bg-brand-500/15 md:block" title={`${done} of ${total} done`}>
            <div className="h-full rounded-full bg-brand-600 transition-[width] duration-500" style={{ width: `${pct}%` }} />
          </div>
          <span className="text-xs font-semibold tabular-nums text-brand-700 dark:text-brand-300">{done}/{total}</span>

          {next && (
            <button
              onClick={() => go(next)}
              className="inline-flex shrink-0 items-center gap-1 rounded-lg bg-brand-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-brand-700"
            >
              Start <ArrowRight size={12} aria-hidden />
            </button>
          )}

          <button
            onClick={() => setExpanded((e) => !e)}
            className="grid h-6 w-6 shrink-0 place-items-center rounded-md text-faint hover:bg-brand-100 dark:hover:bg-brand-500/15 hover:text-dim"
            aria-expanded={expanded}
            title={expanded ? 'Hide steps' : 'Show all steps'}
          >
            {expanded ? <ChevronUp size={15} aria-hidden /> : <ChevronDown size={15} aria-hidden />}
          </button>

          <button
            onClick={() => setDismissed(true)}
            className="grid h-6 w-6 shrink-0 place-items-center rounded-md text-faint hover:bg-brand-100 dark:hover:bg-brand-500/15 hover:text-dim"
            title="Hide it — bring it back with “Show plan” in the top bar"
            aria-label="Hide plan strip"
          >
            <X size={15} aria-hidden />
          </button>
        </div>
      </div>

      {/* Opt-in full step list — a compact chip row, so power users can jump to
          any step without opening the header pill or the assistant. */}
      {expanded && (
        <div className="mx-auto max-w-6xl px-4 pb-2.5">
          <div className="flex flex-wrap gap-1.5">
            {plan.steps.map((s, i) => {
              const d = isStepDone(s);
              const isNext = !!next && s.toolId === next.toolId && !d;
              return (
                <button
                  key={s.toolId}
                  onClick={() => go(s)}
                  className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors ${
                    isNext
                      ? 'border-brand-300 dark:border-brand-500/40 bg-surface font-semibold text-strong'
                      : 'border-line bg-surface/60 hover:bg-surface'
                  }`}
                >
                  <span className={`grid h-4 w-4 shrink-0 place-items-center rounded-full text-[9px] font-bold text-white ${d ? 'bg-green-500' : 'bg-brand-600'}`}>
                    {d ? <Check size={10} aria-hidden /> : i + 1}
                  </span>
                  <span className={d ? 'text-faint line-through' : 'text-dim'}>{stepLabel(s)}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
