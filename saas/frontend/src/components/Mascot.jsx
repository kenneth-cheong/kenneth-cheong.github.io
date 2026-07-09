import { useId } from 'react';

// "Monty the Border Collie" — the assistant's face. Now the real border-collie
// artwork (a copy lives in this app's public/ as monty.jpg) rendered as a circular
// avatar: the image's white background blends into the white ring, so it reads on
// any panel. Swap public/monty.jpg (and assets/monty.jpg in the root site) to
// re-skin every placement at once.
//
// `bare` and `mood` are accepted for API compatibility; the image is the same in
// every placement, so they're currently no-ops. Decorative unless given a `title`.
export default function Mascot({ size = 28, mood = 'idle', className = '', title, bare = false }) { // eslint-disable-line no-unused-vars
  const clip = useId();
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      className={className}
      role={title ? 'img' : undefined}
      aria-label={title || undefined}
      aria-hidden={title ? undefined : true}
    >
      <clipPath id={clip}><circle cx="24" cy="24" r="24" /></clipPath>
      <g clipPath={`url(#${clip})`}>
        <circle cx="24" cy="24" r="24" fill="#fff" />
        {/* Zoomed to the dog's bounding box (crop 60,55–290,285 of the 350² source). */}
        <image href="/monty.jpg" x="-12.52" y="-11.48" width="73.04" height="73.04" />
        {/* Blue support headset overlaid on top of the artwork. */}
        <path d="M8.4 20 Q24 -1 39.6 20" stroke="#2563eb" strokeWidth="2.6" fill="none" strokeLinecap="round" />
        <ellipse cx="8.4" cy="20.5" rx="2.7" ry="4" fill="#2563eb" stroke="#173a8a" strokeWidth="0.5" />
        <ellipse cx="39.6" cy="20.5" rx="2.7" ry="4" fill="#2563eb" stroke="#173a8a" strokeWidth="0.5" />
        <path d="M8.4 24 Q5.5 31 16 32.2" stroke="#2563eb" strokeWidth="1.8" fill="none" strokeLinecap="round" />
        <circle cx="16.3" cy="32.2" r="1.5" fill="#2563eb" />
      </g>
    </svg>
  );
}
