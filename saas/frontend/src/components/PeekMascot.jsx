// Monty's friends — the peeking-animal mascots (art copied into this app's
// public/). Each one is drawn peeking over a horizontal edge and waving, so it
// reads as a character popping up from behind a card divider to cheer the user
// on. Purely decorative: always aria-hidden, never a control.
//
// Swap a PNG in public/ to re-skin every placement of that character at once.
const SRC = {
  otter: '/otter.png',
  koala: '/koala.png',
  cat: '/cat-calico.png',
  'bear-brown': '/bear-brown.png',
  'bear-polar': '/bear-polar.png',
};

// Which character fronts each tool category. Five categories, five friends — so
// every tile in a discipline shares a face and the catalog reads as a cast.
export const CATEGORY_MASCOT = {
  SEO: 'otter',
  Content: 'cat',
  'AI Visibility': 'koala',
  Strategy: 'bear-brown',
  Integrations: 'bear-polar',
};

export default function PeekMascot({ name = 'otter', width = 120, className = '', style }) {
  const src = SRC[name] || SRC.otter;
  return (
    <img
      src={src}
      alt=""
      aria-hidden
      draggable={false}
      width={width}
      className={`pointer-events-none select-none ${className}`}
      style={style}
    />
  );
}
