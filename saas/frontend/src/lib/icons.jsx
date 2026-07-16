// Central icon layer — replaces emoji throughout the app with consistent
// icons. Import named icons directly from 'lucide-react' in components; use
// <CategoryIcon> for a category glyph and <ToolIcon> for a tool's own glyph.
import { Search, PenLine, Bot, Target, Link2 } from 'lucide-react';

const CATEGORY_ICONS = {
  SEO: Search,
  Content: PenLine,
  'AI Visibility': Bot,
  Strategy: Target,
  Integrations: Link2,
};

export function CategoryIcon({ category, size = 16, className = '', ...rest }) {
  const Cmp = CATEGORY_ICONS[category] || Search;
  return <Cmp size={size} className={className} aria-hidden {...rest} />;
}

// Per-tool Font Awesome glyphs — each tool gets a distinct, meaningful icon so
// the catalog is scannable at a glance (the lucide CategoryIcon repeats a single
// glyph across a whole discipline, which reads as "everything here is the same").
// Brand marks use `fa-brands`; everything else `fa-solid`. Font Awesome's CSS is
// imported once in main.jsx. Falls back to the category glyph, then a wand.
const TOOL_FA = {
  // SEO
  'keyword-analysis': 'fa-solid fa-magnifying-glass',
  'rank-checker': 'fa-solid fa-ranking-star',
  'time-to-rank': 'fa-solid fa-hourglass-half',
  'anchor-cleaner': 'fa-solid fa-link-slash',
  'technical-seo': 'fa-solid fa-gears',
  onpage: 'fa-solid fa-file-code',
  'page-analysis': 'fa-solid fa-microscope',
  competitors: 'fa-solid fa-people-arrows',
  backlinks: 'fa-solid fa-link',
  schema: 'fa-solid fa-sitemap',
  'strategy-engine': 'fa-solid fa-chess-knight',
  // Content
  caption: 'fa-solid fa-comment-dots',
  'content-writer': 'fa-solid fa-pen-nib',
  'content-check': 'fa-solid fa-spell-check',
  pillars: 'fa-solid fa-table-columns',
  // AI Visibility
  'ai-discovery': 'fa-solid fa-robot',
  'ai-mentions': 'fa-solid fa-quote-right',
  'llms-txt': 'fa-solid fa-file-lines',
  'geo-onpage': 'fa-solid fa-map-location-dot',
  'forensic-audit': 'fa-solid fa-magnifying-glass-chart',
  // Strategy
  persona: 'fa-solid fa-user-tag',
  'media-plan': 'fa-solid fa-calendar-days',
  'landing-audit': 'fa-solid fa-plane-arrival',
  'sem-copy': 'fa-solid fa-rectangle-ad',
  'perf-marketing': 'fa-solid fa-chart-line',
  'social-audit': 'fa-solid fa-hashtag',
  // Integrations
  gsc: 'fa-brands fa-google',
  ga4: 'fa-solid fa-chart-line',
  'google-ads': 'fa-solid fa-bullhorn',
  'meta-ads': 'fa-brands fa-meta',
  'linkedin-ads': 'fa-brands fa-linkedin',
};

const CATEGORY_FA = {
  SEO: 'fa-solid fa-magnifying-glass',
  Content: 'fa-solid fa-pen-nib',
  'AI Visibility': 'fa-solid fa-robot',
  Strategy: 'fa-solid fa-bullseye',
  Integrations: 'fa-solid fa-plug',
};

export function toolFaClass(tool) {
  return TOOL_FA[tool?.id] || CATEGORY_FA[tool?.category] || 'fa-solid fa-wand-magic-sparkles';
}

export function ToolIcon({ tool, className = '' }) {
  return <i className={`${toolFaClass(tool)} ${className}`} aria-hidden />;
}
