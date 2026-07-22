import { CATEGORY_META } from '@shared/catalog.mjs';

// The one place that answers "what colour is this discipline?".
//
// There used to be two answers. Tool cards read the themed CSS variables
// (--cat-*, index.css), which royal and dark re-point because catalog.mjs's SEO
// blue IS the royal canvas. The sidebar and chip dots read CATEGORY_META's raw
// hex inline. In light they agreed, so it looked fine; in dark and royal the
// re-pointed set is not a recolour of the same order — Content is green there and
// Integrations is purple, the exact reverse of the catalog — so the dot beside
// "Content" and the cards under it were different colours. Reported as
// "Content and Integrations are swapped", and true only in the dark themes.
//
// CATEGORY_META stays the fallback: it is the value the CSS variables default
// to, and it is what the backend-shared catalog knows. This just makes sure the
// variable wins wherever one exists.
const HUE_VAR = {
  SEO: '--cat-seo',
  Content: '--cat-content',
  'AI Visibility': '--cat-ai',
  Strategy: '--cat-strategy',
  Integrations: '--cat-integrations',
};

const FALLBACK = '#64748b';

/** CSS colour for a category — themed variable, with the catalog hex behind it. */
export function categoryHue(category) {
  const hex = CATEGORY_META[category]?.color || FALLBACK;
  return HUE_VAR[category] ? `var(${HUE_VAR[category]}, ${hex})` : hex;
}
