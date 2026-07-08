import { useId } from 'react';

// "Monty the Border Collie" — the assistant's face. A friendly border collie drawn
// as inline SVG so we're not blocked on a designer: it needs no asset pipeline.
// Swap the guts of this one component for real artwork (or an <img>) later and
// every placement updates at once.
//
// `bare` drops the soft background circle and frames Monty tightly — use it where
// the host already provides shape/contrast (e.g. the nav button), so he can be
// larger. The default keeps the circle so it reads on the dark panel header.
// `mood` is accepted for API compatibility. Decorative unless given a `title`.
export default function Mascot({ size = 28, mood = 'idle', className = '', title, bare = false }) { // eslint-disable-line no-unused-vars
  const clip = useId();
  // Monty himself (native coords, no background). Reused by both variants.
  const parts = (
    <>
      {/* ears */}
      <path d="M11 16 L14.5 6 L20 12 Z" fill="#2b2b2b" stroke="#2b2b2b" strokeWidth="2.5" strokeLinejoin="round" />
      <path d="M37 16 L33.5 6 L28 12 Z" fill="#2b2b2b" stroke="#2b2b2b" strokeWidth="2.5" strokeLinejoin="round" />
      {/* head */}
      <circle cx="24" cy="23" r="12.5" fill="#2b2b2b" />
      {/* white blaze + muzzle */}
      <path d="M24 10 Q21.5 10 21.5 15.5 Q21.5 21 24 21 Q26.5 21 26.5 15.5 Q26.5 10 24 10 Z" fill="#f7f7f7" />
      <ellipse cx="24" cy="29.5" rx="8.5" ry="7" fill="#f7f7f7" />
      {/* tongue */}
      <path d="M22 32.2 Q24 35.8 26 32.2 Z" fill="#f28a8a" />
      {/* eyes */}
      <ellipse cx="17.8" cy="18.5" rx="2.2" ry="2.6" fill="#8a5a2b" />
      <circle cx="17.8" cy="18.8" r="1.2" fill="#201509" />
      <circle cx="17.2" cy="17.9" r="0.5" fill="#fff" />
      <ellipse cx="30.2" cy="18.5" rx="2.2" ry="2.6" fill="#8a5a2b" />
      <circle cx="30.2" cy="18.8" r="1.2" fill="#201509" />
      <circle cx="29.6" cy="17.9" r="0.5" fill="#fff" />
      {/* nose + mouth */}
      <ellipse cx="24" cy="27" rx="2.7" ry="2.1" fill="#1a1a1a" />
      <circle cx="23" cy="26.3" r="0.7" fill="#5a5a5a" />
      <path d="M24 29V31" stroke="#2b2b2b" strokeWidth="1.1" strokeLinecap="round" />
      <path d="M24 31Q21 33.2 18.8 31.4M24 31Q27 33.2 29.2 31.4" stroke="#2b2b2b" strokeWidth="1.1" fill="none" strokeLinecap="round" />
      {/* headset — blue so it pops on the black fur (band, ear cups, mic boom) */}
      <path d="M11.5 20A13 13 0 0 1 36.5 20" stroke="#2563eb" strokeWidth="2.6" fill="none" strokeLinecap="round" />
      <ellipse cx="11.5" cy="20.5" rx="2.6" ry="3.9" fill="#2563eb" />
      <ellipse cx="36.5" cy="20.5" rx="2.6" ry="3.9" fill="#2563eb" />
      <path d="M11.5 23.8C9.5 27.5 11.2 31.5 17.6 31.8" stroke="#2563eb" strokeWidth="1.8" fill="none" strokeLinecap="round" />
      <circle cx="17.9" cy="31.9" r="1.5" fill="#2563eb" />
    </>
  );
  return (
    <svg
      width={size}
      height={size}
      viewBox={bare ? '7 4 34 34' : '0 0 48 48'}
      fill="none"
      className={className}
      role={title ? 'img' : undefined}
      aria-label={title || undefined}
      aria-hidden={title ? undefined : true}
    >
      {bare ? (
        parts
      ) : (
        <>
          <clipPath id={clip}><circle cx="24" cy="24" r="24" /></clipPath>
          <g clipPath={`url(#${clip})`}>
            {/* avatar background */}
            <circle cx="24" cy="24" r="24" fill="#e8f0ff" />
            {/* Nudge Monty down ~3 units so he sits centred in the circle. */}
            <g transform="translate(0 3)">{parts}</g>
          </g>
        </>
      )}
    </svg>
  );
}
