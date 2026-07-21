import { Link } from 'react-router-dom';
import { Lock, ArrowRight } from 'lucide-react';
import { PLANS, CATEGORY_META, tierMeets, etaLabel } from '@shared/catalog.mjs';
import { ToolIcon } from '../lib/icons.jsx';

// A tool tile: a photo header carrying the category's hue — glyph top-left,
// tool name across the bottom — then the description and a go-arrow that
// slides on hover. The category hue is handed to the wash as --tc;
// .dm-tool-illus (src/index.css) does the rest.
//
// Locked tools STAY VISIBLE with a tier pill + lock — never hidden.
//
// Deliberately NO per-tool credit cost here. Pricing every tile trained users to
// shop by price instead of by job. The full cost table lives on its own page
// (/credit-guide, linked from the rail) for anyone who wants to plan spend.

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
        {/* Decoration: one Unsplash photo per tool, blended into the hue. Empty
            alt + a silent failure — a missing file must never break the tile. */}
        <img
          src={`/tool-art/${tool.id}.webp`}
          alt=""
          aria-hidden
          loading="lazy"
          decoding="async"
          className="dm-tool-photo"
          onError={(e) => { e.currentTarget.style.display = 'none'; }}
        />
        <div className="flex items-start justify-between gap-2">
          <ToolIcon tool={tool} className="dm-tool-glyph text-white" />
          {/* Tier lock rides on the wash, where it reads against any hue. */}
          {!unlocked && (
            <span className="flex items-center gap-1 rounded-full bg-black/40 px-2 py-0.5 text-[10px] font-bold uppercase text-white backdrop-blur-sm">
              <Lock size={10} aria-hidden /> {PLANS[tool.minTier].name}
            </span>
          )}
        </div>
        <h3 className="dm-tool-name">{tool.name}</h3>
      </div>

      <div className="flex flex-1 flex-col gap-1.5 p-3.5">
        <p className="flex-1 text-[10.5px] leading-relaxed text-muted">{tool.desc}</p>
        <div className="mt-0.5 flex items-center justify-between gap-2">
          <span className="flex min-w-0 items-center gap-2">
            {tool.slow && <span className="truncate text-[10px] text-faint">~{etaLabel(tool)}</span>}
            {!unlocked && tool.teaser && <span className="truncate text-[10px] font-semibold text-peri">1 free preview</span>}
          </span>
          <ArrowRight size={15} aria-hidden className="shrink-0 text-faint transition group-hover:translate-x-0.5 group-hover:text-heading" />
        </div>
      </div>
    </Link>
  );
}
