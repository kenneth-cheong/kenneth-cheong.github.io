import { Link } from 'react-router-dom';
import { Lock, ArrowRight } from 'lucide-react';
import { PLANS, CREDIT_COSTS, CATEGORY_META, tierMeets } from '@shared/catalog.mjs';
import { CategoryIcon } from '../lib/icons.jsx';

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

export default function ToolCard({ tool, userTier }) {
  const unlocked = tierMeets(userTier, tool.minTier);
  const cost = CREDIT_COSTS[tool.cost] ?? 0;
  const meta = CATEGORY_META[tool.category] || { color: '#64748b' };
  const hue = HUE_VAR[tool.category]
    ? `var(${HUE_VAR[tool.category]}, ${meta.color})`
    : meta.color;

  // Unlocked, ToolRunner-backed tools open the run popup (mockup: a card opens
  // #modal-tool, it doesn't navigate). Tools with their own route (/audit,
  // /tracking) and locked tools still navigate — the page owns the teaser and
  // upsell paths, and a popup would have to duplicate them.
  const asPopup = unlocked && !tool.route;
  const open = (e) => {
    e.preventDefault();
    window.dispatchEvent(new CustomEvent('dm:open-tool', { detail: { id: tool.id } }));
  };

  return (
    <Link
      to={tool.route || `/tool/${tool.id}`}
      onClick={asPopup ? open : undefined}
      style={{ '--tc': hue }}
      className={`card card-hover group relative flex flex-col overflow-hidden ${unlocked ? '' : 'border-dashed'}`}
    >
      <div className="dm-tool-illus">
        <CategoryIcon category={tool.category} size={32} className="text-white" />
        {/* Tier lock rides on the wash, where it reads against any category hue. */}
        {!unlocked && (
          <span className="absolute right-2 top-2 flex items-center gap-1 rounded-full bg-black/35 px-2 py-0.5 text-[10px] font-bold uppercase text-white backdrop-blur-sm">
            <Lock size={10} aria-hidden /> {PLANS[tool.minTier].name}
          </span>
        )}
      </div>

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
