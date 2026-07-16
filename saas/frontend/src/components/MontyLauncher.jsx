import Mascot from './Mascot.jsx';

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
        <span className="dm-monty-badge" aria-hidden />
      </button>
    </div>
  );
}
