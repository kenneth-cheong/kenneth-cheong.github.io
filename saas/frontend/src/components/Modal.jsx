import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';

// The approved design's popup (mockup .modal + .ov). Portalled to <body> so it
// escapes any transformed/overflow-hidden ancestor — a fixed element inside a
// `transform`ed parent positions against that parent, not the viewport, which
// is exactly the bug you get nesting this inside an animated card.
//
// It stays mounted for one frame in its closed state before opening, because a
// panel that mounts already at its final transform has nothing to animate from.
export default function Modal({ open, onClose, title, titleNote, tag, children, footer, labelledBy, wide = false }) {
  const [mounted, setMounted] = useState(false);   // in the DOM at all
  const [shown, setShown] = useState(false);       // .dm-modal-open applied
  const panelRef = useRef(null);
  const restoreRef = useRef(null);

  // Mount → next frame → open, so the transition has a start state to run from.
  // On close, keep it mounted until the transition finishes (240ms per the CSS).
  useEffect(() => {
    if (open) {
      restoreRef.current = document.activeElement;
      setMounted(true);
      const r = requestAnimationFrame(() => setShown(true));
      return () => cancelAnimationFrame(r);
    }
    setShown(false);
    const t = setTimeout(() => setMounted(false), 240);
    return () => clearTimeout(t);
  }, [open]);

  // Move focus into the panel when it opens, and hand it back on close — a
  // portalled dialog otherwise leaves focus stranded behind the scrim.
  useEffect(() => {
    if (!shown || !panelRef.current) return;
    const target = panelRef.current.querySelector('[data-autofocus]') || panelRef.current;
    target.focus?.({ preventScroll: true });
    return () => restoreRef.current?.focus?.({ preventScroll: true });
  }, [shown]);

  // Escape closes; while open the page behind must not scroll.
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose?.(); } };
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.removeEventListener('keydown', onKey); document.body.style.overflow = prev; };
  }, [open, onClose]);

  if (!mounted) return null;

  return createPortal(
    <>
      <div className={`dm-scrim ${shown ? 'dm-scrim-open' : ''}`} onClick={onClose} aria-hidden />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        tabIndex={-1}
        className={`dm-modal ${wide ? 'dm-modal-wide' : ''} ${shown ? 'dm-modal-open' : ''}`}
      >
        <div className="dm-modal-head">
          {tag && <span className="dm-modal-tag">{tag}</span>}
          <h3 id={labelledBy} className="flex-1 text-[17px] font-extrabold text-heading">
            {title}
            {titleNote && <span className="ml-1.5 text-[13px] font-semibold text-muted">· {titleNote}</span>}
          </h3>
          <button type="button" onClick={onClose} className="dm-modal-x" aria-label="Close">
            <X size={16} aria-hidden />
          </button>
        </div>
        <div className="dm-modal-body">{children}</div>
        {footer && <div className="flex flex-wrap gap-2.5 border-t border-line p-5">{footer}</div>}
      </div>
    </>,
    document.body
  );
}
