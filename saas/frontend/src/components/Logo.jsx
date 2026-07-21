// The Digimetrics wordmark. Two artworks ship — the METRICS half is outlined,
// so it needs white ink on a dark canvas and deep blue on a light one. Both
// <img>s render and CSS shows exactly one (see `.dm-logo` in index.css); doing
// the swap in CSS rather than JS means the right mark is painted on the very
// first frame, before React has read the theme preference, and it keeps working
// for `system` → OS flips without a re-render.
//
// Royal carries BOTH `dark` and `royal` classes (see lib/theme.js), so keying
// off `.dark` covers dark + royal and the bare selector covers light.
export default function Logo({ className = '', width = 160 }) {
  return (
    <span className={`dm-logo ${className}`} style={{ width }} role="img" aria-label="Digimetrics">
      <img src="/digimetrics-logo-on-light.png" alt="" className="dm-logo-on-light" />
      <img src="/digimetrics-logo-on-dark.png" alt="" className="dm-logo-on-dark" />
    </span>
  );
}
