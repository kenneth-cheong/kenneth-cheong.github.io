import { useState, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Info } from 'lucide-react';
import { GLOSSARY } from '@shared/catalog.mjs';

// Plain-English definition for a metric label (case-insensitive). Also tries a
// couple of light normalisations ("Avg. Position" → "Avg Position") so backend
// labels line up with the glossary without needing an exact key for each.
export function glossaryFor(label) {
  const k = String(label || '').trim();
  if (!k) return null;
  if (GLOSSARY[k]) return GLOSSARY[k];
  const lower = k.toLowerCase();
  const hit = Object.keys(GLOSSARY).find((g) => g.toLowerCase() === lower);
  if (hit) return GLOSSARY[hit];
  // Strip trailing units/qualifiers in parentheses, e.g. "PageSpeed (mobile)".
  const bare = k.replace(/\s*\([^)]*\)\s*$/, '').trim();
  if (bare && bare !== k) return glossaryFor(bare);
  return null;
}

// A small "i" info icon that reveals a plain-English tooltip on hover/focus.
// The tooltip is portalled to <body> with position:fixed so it can't be
// clipped by any overflow-auto / card container. Shared by every metric
// surface (stat cards, table headers, KPI tiles) for one consistent affordance.
export default function InfoTip({ text, size = 13, className = '' }) {
  const ref = useRef(null);
  const [pos, setPos] = useState(null);
  if (!text) return null;
  const show = () => {
    const r = ref.current?.getBoundingClientRect();
    if (r) setPos({ x: r.left + r.width / 2, y: r.bottom + 6 });
  };
  const hide = () => setPos(null);
  return (
    <button
      type="button"
      ref={ref}
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
      onClick={(e) => { e.stopPropagation(); e.preventDefault(); }}
      className={`inline-flex cursor-help align-middle text-slate-300 transition-colors hover:text-brand-500 focus:text-brand-500 focus:outline-none ${className}`}
      aria-label={text}
    >
      <Info size={size} aria-hidden />
      {pos && createPortal(
        <span
          role="tooltip"
          style={{ position: 'fixed', left: pos.x, top: pos.y, transform: 'translateX(-50%)', zIndex: 70 }}
          className="pointer-events-none max-w-[240px] rounded-lg bg-slate-800 px-2.5 py-1.5 text-[11px] font-normal normal-case leading-snug tracking-normal text-white shadow-lg"
        >
          {text}
        </span>,
        document.body,
      )}
    </button>
  );
}
