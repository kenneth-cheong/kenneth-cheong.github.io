import Mascot from './Mascot.jsx';
import { usePlan } from '../context/PlanContext.jsx';

// The approved design's floating launcher (mockup .monty-fab): a white pill
// with the animated gradient wordmark and a tail, beside a gradient avatar
// button carrying a live badge and a slow ping.
//
// Monty's avatar STAYS put while the assistant panel is open — the character
// anchors the panel to its corner and keeps a constant presence. It just turns
// into a toggle: closed → opens the panel; open → minimizes it back down. The
// "Ask Monty anything" invitation pill and the attention ping only show while
// closed, since neither makes sense once the panel is already up.
export default function MontyLauncher({ open, onOpen, onClose }) {
  const toggle = () => (open ? onClose?.() : onOpen?.());
  // When a plan is live, the badge carries the number of steps left instead of a
  // bare "online" dot — a passive, always-visible reminder that there's a plan to
  // get back to, without opening the panel or eating any of its space.
  const { hasPlan, progress } = usePlan();
  const remaining = hasPlan && !progress.complete ? progress.total - progress.done : 0;
  return (
    <div className="dm-monty-fab">
      {!open && (
        <button type="button" onClick={onOpen} className="dm-monty-label" aria-hidden tabIndex={-1}>
          Ask Monty <span className="dm-mg">anything</span>
        </button>
      )}
      <button
        type="button"
        onClick={toggle}
        className="dm-monty-btn"
        title={open ? 'Minimize Monty' : 'Ask Monty anything'}
        aria-label={open ? 'Minimize the Monty assistant' : 'Open Monty the assistant'}
        aria-expanded={open}
      >
        {!open && <span className="dm-monty-ping" aria-hidden />}
        <span className="grid h-[52px] w-[52px] place-items-center overflow-hidden rounded-full">
          <Mascot bare size={52} />
        </span>
        {remaining > 0 ? (
          <span
            className="absolute -right-1 -top-1 grid h-[19px] min-w-[19px] place-items-center rounded-full border-[2.5px] border-[#22349f] bg-brand-600 px-1 text-[10px] font-bold leading-none text-white"
            title={`${remaining} plan step${remaining === 1 ? '' : 's'} left`}
            aria-hidden
          >
            {remaining > 9 ? '9+' : remaining}
          </span>
        ) : (
          <span className="dm-monty-badge" aria-hidden />
        )}
      </button>
    </div>
  );
}
