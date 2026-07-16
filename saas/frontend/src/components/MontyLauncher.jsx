import Mascot from './Mascot.jsx';

// The approved design's floating launcher (mockup .monty-fab): a white pill
// with the animated gradient wordmark and a tail, beside a gradient avatar
// button carrying a live badge and a slow ping.
//
// Hidden while the assistant panel is open — the mockup never shows both, and a
// FAB that opens what's already open is just a dead control.
export default function MontyLauncher({ open, onOpen }) {
  if (open) return null;
  return (
    <div className="dm-monty-fab">
      <button type="button" onClick={onOpen} className="dm-monty-label" aria-hidden tabIndex={-1}>
        Ask Monty <span className="dm-mg">anything</span>
      </button>
      <button
        type="button"
        onClick={onOpen}
        className="dm-monty-btn"
        title="Ask Monty anything"
        aria-label="Open Monty the assistant"
      >
        <span className="dm-monty-ping" aria-hidden />
        <span className="grid h-[52px] w-[52px] place-items-center overflow-hidden rounded-full">
          <Mascot bare size={52} />
        </span>
        <span className="dm-monty-badge" aria-hidden />
      </button>
    </div>
  );
}
