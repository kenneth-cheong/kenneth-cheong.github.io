import { useId } from 'react';

// "Helpful Otter" — the assistant's face. A friendly otter avatar drawn as inline
// SVG so we're not blocked on a designer: it needs no asset pipeline and frames
// itself in a soft circle that reads on both the dark panel header and light
// reply bubbles. Swap the guts of this one component for real artwork (or an
// <img>) later and every placement updates at once.
//
// `mood` nudges the expression: 'idle' (default) or 'happy' (bigger smile, e.g.
// on the welcome/first-run moment). Decorative by default — callers own their
// aria context — so it's aria-hidden unless given a `title`.
export default function Mascot({ size = 28, mood = 'idle', className = '', title }) {
  const clip = useId();
  const smile = mood === 'happy'
    ? 'M24 30.4Q21.5 33 19.6 31.4M24 30.4Q26.5 33 28.4 31.4'
    : 'M24 30.4Q22 32.4 20.2 31.2M24 30.4Q26 32.4 27.8 31.2';
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      fill="none"
      className={className}
      role={title ? 'img' : undefined}
      aria-label={title || undefined}
      aria-hidden={title ? undefined : true}
    >
      <clipPath id={clip}><circle cx="24" cy="24" r="24" /></clipPath>
      <g clipPath={`url(#${clip})`}>
        {/* avatar background */}
        <circle cx="24" cy="24" r="24" fill="#e8f0ff" />
        {/* ears (behind head) */}
        <circle cx="14.5" cy="13.5" r="3.4" fill="#7d5236" />
        <circle cx="14.5" cy="13.9" r="1.7" fill="#5c3c28" />
        <circle cx="33.5" cy="13.5" r="3.4" fill="#7d5236" />
        <circle cx="33.5" cy="13.9" r="1.7" fill="#5c3c28" />
        {/* head */}
        <circle cx="24" cy="23" r="13" fill="#9c6b4a" />
        {/* muzzle / cheeks */}
        <ellipse cx="24" cy="29" rx="9.5" ry="7" fill="#f0e2d2" />
        <circle cx="15.8" cy="30" r="1.9" fill="#f2a0a0" opacity="0.3" />
        <circle cx="32.2" cy="30" r="1.9" fill="#f2a0a0" opacity="0.3" />
        {/* eyes */}
        <circle cx="18.8" cy="20" r="2.9" fill="#fff" />
        <circle cx="19.2" cy="20.3" r="1.9" fill="#2a1c12" />
        <circle cx="18.4" cy="19.4" r="0.7" fill="#fff" />
        <circle cx="29.2" cy="20" r="2.9" fill="#fff" />
        <circle cx="28.8" cy="20.3" r="1.9" fill="#2a1c12" />
        <circle cx="28" cy="19.4" r="0.7" fill="#fff" />
        {/* nose (heart) */}
        <path d="M24 28.4c-1.8-1-3-2-3-3.2 0-1 .9-1.6 1.7-1.6.6 0 1 .3 1.3.8.3-.5.7-.8 1.3-.8.8 0 1.7.6 1.7 1.6 0 1.2-1.2 2.2-3 3.2z" fill="#3d2820" />
        {/* mouth */}
        <path d="M24 28.4V30.4" stroke="#5c3c28" strokeWidth="1.2" strokeLinecap="round" />
        <path d={smile} stroke="#5c3c28" strokeWidth="1.3" fill="none" strokeLinecap="round" />
        {/* whiskers */}
        <path d="M15 27 9 25.5M15 29H8.5M15 31 9 32.5" stroke="#cbb9a7" strokeWidth="0.9" strokeLinecap="round" />
        <path d="M33 27 39 25.5M33 29H39.5M33 31 39 32.5" stroke="#cbb9a7" strokeWidth="0.9" strokeLinecap="round" />
        {/* headset — band over the crown, ear cups, mic boom to the mouth */}
        <path d="M12.6 14.5A12 12 0 0 1 35.4 14.5" stroke="#2b3648" strokeWidth="2.4" fill="none" strokeLinecap="round" />
        <ellipse cx="12.6" cy="16.5" rx="2.4" ry="3.5" fill="#2b3648" />
        <ellipse cx="35.4" cy="16.5" rx="2.4" ry="3.5" fill="#2b3648" />
        <path d="M12.6 19.6C10.6 24 12.2 29 19 29.6" stroke="#2b3648" strokeWidth="1.7" fill="none" strokeLinecap="round" />
        <circle cx="19.3" cy="29.7" r="1.5" fill="#2b3648" />
      </g>
    </svg>
  );
}
