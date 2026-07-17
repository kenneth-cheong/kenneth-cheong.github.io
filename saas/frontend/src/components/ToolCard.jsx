import { Link } from 'react-router-dom';
import { Lock, ArrowRight } from 'lucide-react';
import { PLANS, CREDIT_COSTS, CATEGORY_META, tierMeets } from '@shared/catalog.mjs';
import { ToolIcon } from '../lib/icons.jsx';
import PeekMascot, { CATEGORY_MASCOT } from './PeekMascot.jsx';

// A tool tile, in the approved design (mockups/saas-overview.html .tool-card):
// a colour-washed illustration header carrying the category's hue, then name,
// description, cost and a go-arrow that slides on hover. The category hue is
// handed to the wash as --tc; .dm-tool-illus (src/index.css) does the rest.
//
// Locked tools STAY VISIBLE with a tier pill + lock — never hidden.

// Per-theme category hues live in CSS (--cat-*, see index.css) because the right
// hue depends on the canvas: catalog.mjs's SEO blue is royal's own background.
// CATEGORY_META.color stays the fallback for any category CSS doesn't name.
const HUE_VAR = {
  SEO: '--cat-seo',
  Content: '--cat-content',
  'AI Visibility': '--cat-ai',
  Strategy: '--cat-strategy',
  Integrations: '--cat-integrations',
};

export default function ToolCard({ tool, userTier, onNavigate }) {
  const unlocked = tierMeets(userTier, tool.minTier);
  const cost = CREDIT_COSTS[tool.cost] ?? 0;
  const meta = CATEGORY_META[tool.category] || { color: '#64748b' };
  const hue = HUE_VAR[tool.category]
    ? `var(${HUE_VAR[tool.category]}, ${meta.color})`
    : meta.color;

  // Every tool opens as its OWN PAGE — the generic ToolRunner at /tool/:id, or
  // the tool's bespoke route (only Social Media Audit has one). One behaviour for
  // all tools; locked tools land on the page's teaser/upsell. A plain Link, so
  // the page deep-links and ⌘-click opens the tool in a new tab.
  return (
    <Link
      to={tool.route || `/tool/${tool.id}`}
      onClick={onNavigate}
      style={{ '--tc': hue }}
      className={`card card-hover group relative flex flex-col overflow-hidden ${unlocked ? '' : 'border-dashed'}`}
    >
      <div className="dm-tool-illus">
        <ToolIcon tool={tool} className="dm-tool-glyph text-white" />
        {/* Tier lock rides on the wash, where it reads against any category hue. */}
        {!unlocked && (
          <span className="absolute right-2 top-2 flex items-center gap-1 rounded-full bg-black/35 px-2 py-0.5 text-[10px] font-bold uppercase text-white backdrop-blur-sm">
            <Lock size={10} aria-hidden /> {PLANS[tool.minTier].name}
          </span>
        )}
      </div>

      {/* The category's mascot breaks the frame — it sits on the illustration's
          bottom edge and PROTRUDES down into the card body (like the mockup's
          105%-tall banner figure), waving the user in. A card child (not an illus
          child) so the wash's overflow-hidden doesn't clip it; it pops up a touch
          on card hover. Decorative (aria-hidden inside PeekMascot). */}
      <PeekMascot
        name={CATEGORY_MASCOT[tool.category]}
        width={62}
        className="dm-tool-peek absolute right-2 top-[54px] z-[1]"
      />

      <div className="flex flex-1 flex-col gap-1.5 p-3.5">
        <h3 className="text-[13px] font-bold leading-tight text-heading">{tool.name}</h3>
        <p className="flex-1 text-[10.5px] leading-relaxed text-muted">{tool.desc}</p>
        <div className="mt-0.5 flex items-center justify-between gap-2">
          <span className={`rounded-lg px-2 py-[3px] text-[10px] font-bold ${cost === 0 ? 'bg-pos/15 text-pos' : 'bg-sunken text-dim'}`}>
            {cost === 0 ? 'Free' : `${cost} credit${cost > 1 ? 's' : ''}`}
          </span>
          <span className="flex min-w-0 items-center gap-2">
            {tool.slow && <span className="truncate text-[10px] text-faint">~30–150s</span>}
            {!unlocked && tool.teaser && <span className="truncate text-[10px] font-semibold text-peri">1 free preview</span>}
            <ArrowRight size={15} aria-hidden className="shrink-0 text-faint transition group-hover:translate-x-0.5 group-hover:text-heading" />
          </span>
        </div>
      </div>
    </Link>
  );
}
