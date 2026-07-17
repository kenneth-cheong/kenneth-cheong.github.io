import { useNavigate } from 'react-router-dom';
import { Target, PartyPopper } from 'lucide-react';
import { usePlan } from '../context/PlanContext.jsx';

// The header's plan chip. An ACTIVE plan is owned by the full-width strip under
// the nav (PlanBreadcrumb) — which already carries the progress, the next step, a
// Start button and the full step list. Rendering a pill for it too put "Up next"
// on screen twice, stacked. So this now covers ONLY the states the strip doesn't:
//
//   • no plan yet  → a "Set a goal" CTA (the platform tour anchors on this)
//   • plan complete → a quiet celebration + a way back to set a new goal
//
// Anything else → null, and the strip speaks for the plan.
export default function PlanWidget() {
  const { hasPlan, progress } = usePlan();
  const navigate = useNavigate();

  // No plan yet → a brand-tinted nudge to set one, so the north star stays
  // discoverable next to the neutral meters.
  if (!hasPlan) {
    return (
      <button
        onClick={() => navigate('/')}
        data-tour="plan-widget"
        title="Set your goal and get a step-by-step plan"
        className="hidden items-center gap-1.5 rounded-lg border border-brand-200 dark:border-brand-500/30 bg-brand-50 dark:bg-brand-500/10 px-2.5 py-1.5 text-sm font-semibold text-brand-700 dark:text-brand-300 hover:bg-brand-100 dark:hover:bg-brand-500/15 sm:inline-flex"
      >
        <Target size={16} aria-hidden /><span className="hidden md:inline">Set a goal</span>
      </button>
    );
  }

  // An active plan is the strip's job — don't say "Up next" twice.
  if (!progress.complete) return null;

  return (
    <button
      onClick={() => navigate('/')}
      data-tour="plan-widget"
      title="Your plan — all done. Set a new goal."
      className="inline-flex items-center gap-1.5 rounded-lg border border-green-200 dark:border-green-500/30 bg-green-50 dark:bg-green-500/10 px-2.5 py-1.5 text-sm font-semibold text-green-700 dark:text-green-300 hover:bg-green-100 dark:hover:bg-green-500/15"
    >
      <PartyPopper size={16} aria-hidden /><span className="hidden md:inline">Plan complete</span>
    </button>
  );
}
