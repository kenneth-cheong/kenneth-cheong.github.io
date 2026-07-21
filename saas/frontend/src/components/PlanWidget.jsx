import { useLocation, useNavigate } from 'react-router-dom';
import { Target, PartyPopper } from 'lucide-react';
import { usePlan } from '../context/PlanContext.jsx';
import { usePlanStripDismissed } from '../lib/planStrip.js';

// The header's plan chip. An ACTIVE plan is owned by the full-width strip under
// the nav (PlanBreadcrumb) — which already carries the progress, the next step, a
// Start button and the full step list. Rendering a pill for it too put "Up next"
// on screen twice, stacked. So this now covers ONLY the states the strip doesn't:
//
//   • no plan yet  → a "Set a goal" CTA (the platform tour anchors on this)
//   • plan complete → a quiet celebration + a way back to set a new goal
//   • strip dismissed → a "Show plan" chip that brings it back
//
// Anything else → null, and the strip speaks for the plan.
export default function PlanWidget() {
  const { hasPlan, progress } = usePlan();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [stripDismissed, setStripDismissed] = usePlanStripDismissed();

  // Go to the dashboard if we aren't there, then bring the planner into view.
  // The rAF/timeout dance covers the case where the dashboard is still mounting
  // after navigate() — the element doesn't exist yet on the first frame.
  const openPlanner = () => {
    if (pathname !== '/') navigate('/');
    const reveal = (tries = 0) => {
      const el = document.querySelector('[data-tour="pathway"]');
      if (!el) {
        if (tries < 20) requestAnimationFrame(() => reveal(tries + 1));
        return;
      }
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      // Make it obvious which thing the button just pointed at.
      el.classList.add('dm-flash');
      setTimeout(() => el.classList.remove('dm-flash'), 1600);
      const focusable = el.querySelector('button, input, select, textarea, [tabindex]');
      focusable?.focus({ preventScroll: true });
    };
    requestAnimationFrame(() => reveal());
  };

  // No plan yet → a brand-tinted nudge to set one, so the north star stays
  // discoverable next to the neutral meters.
  //
  // This used to just navigate('/'), which is why it read as "not clickable":
  // the goal planner sits well below the fold on the dashboard (under the
  // cockpit, checklist, explorer card and surveys), so from the dashboard the
  // click did nothing visible at all, and from elsewhere it dumped you at the
  // top of a page with no obvious connection to the button you pressed. Now it
  // navigates AND scrolls the planner into view, focusing it so keyboard users
  // land there too.
  if (!hasPlan) {
    return (
      <button
        onClick={openPlanner}
        data-tour="plan-widget"
        title="Set your goal and get a step-by-step plan"
        aria-label="Set a goal"
        className="hidden items-center gap-1.5 rounded-lg border border-brand-200 dark:border-brand-500/30 bg-brand-50 dark:bg-brand-500/10 px-2.5 py-1.5 text-sm font-semibold text-brand-700 dark:text-brand-300 hover:bg-brand-100 dark:hover:bg-brand-500/15 sm:inline-flex"
      >
        <Target size={16} aria-hidden /><span className="hidden md:inline">Set a goal</span>
      </button>
    );
  }

  // Strip hidden for the session → this is the only plan affordance left in the
  // nav, so it becomes the way back. Without it the ✕ read as permanent: the
  // flag lives in sessionStorage, so even a reload wouldn't undo it.
  if (!progress.complete && stripDismissed) {
    return (
      <button
        onClick={() => setStripDismissed(false)}
        data-tour="plan-widget"
        title="Show the plan strip again"
        aria-label="Show plan"
        className="inline-flex items-center gap-1.5 rounded-lg border border-brand-200 dark:border-brand-500/30 bg-brand-50 dark:bg-brand-500/10 px-2.5 py-1.5 text-sm font-semibold text-brand-700 dark:text-brand-300 hover:bg-brand-100 dark:hover:bg-brand-500/15"
      >
        <Target size={16} aria-hidden /><span className="hidden md:inline">Show plan</span>
      </button>
    );
  }

  // An active plan is the strip's job — don't say "Up next" twice.
  if (!progress.complete) return null;

  return (
    <button
      onClick={openPlanner}
      data-tour="plan-widget"
      title="Your plan — all done. Set a new goal."
      aria-label="Plan complete — set a new goal"
      className="inline-flex items-center gap-1.5 rounded-lg border border-green-200 dark:border-green-500/30 bg-green-50 dark:bg-green-500/10 px-2.5 py-1.5 text-sm font-semibold text-green-700 dark:text-green-300 hover:bg-green-100 dark:hover:bg-green-500/15"
    >
      <PartyPopper size={16} aria-hidden /><span className="hidden md:inline">Plan complete</span>
    </button>
  );
}
