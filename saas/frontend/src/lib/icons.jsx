// Central icon layer — replaces emoji throughout the app with consistent
// lucide-react line icons. Import named icons directly from 'lucide-react' in
// components; use <CategoryIcon> for the catalog's per-category glyph.
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
