import { Link } from 'react-router-dom';
import { Lock } from 'lucide-react';
import { PLANS, CREDIT_COSTS, CATEGORY_META, tierMeets } from '@shared/catalog.mjs';
import { CategoryIcon } from '../lib/icons.jsx';

// A tool tile. Locked tools STAY VISIBLE with a tier pill + lock — never hidden.
export default function ToolCard({ tool, userTier }) {
  const unlocked = tierMeets(userTier, tool.minTier);
  const cost = CREDIT_COSTS[tool.cost] ?? 0;
  const meta = CATEGORY_META[tool.category] || { color: '#64748b' };

  return (
    <Link
      to={`/tool/${tool.id}`}
      className={`card card-hover group relative flex flex-col overflow-hidden p-4 pl-5 ${unlocked ? '' : 'border-dashed'}`}
    >
      <span className="absolute inset-y-0 left-0 w-1" style={{ background: meta.color }} aria-hidden />
      <div className="flex items-start justify-between">
        <span className="inline-flex items-center gap-1.5 rounded-md bg-slate-100 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
          <CategoryIcon category={tool.category} size={12} />{tool.category}
        </span>
        {!unlocked && (
          <span className="flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-bold uppercase text-amber-700">
            <Lock size={11} aria-hidden /> {PLANS[tool.minTier].name}
          </span>
        )}
      </div>
      <h3 className="mt-3 font-semibold text-slate-900 group-hover:text-brand-700">{tool.name}</h3>
      <p className="mt-1 flex-1 text-sm text-slate-500">{tool.desc}</p>
      <div className="mt-3 flex items-center justify-between text-xs">
        <span className={`rounded-full px-2 py-0.5 font-semibold ${cost === 0 ? 'bg-green-50 text-green-700' : 'bg-slate-100 text-slate-600'}`}>
          {cost === 0 ? 'Free' : `${cost} credit${cost > 1 ? 's' : ''}`}
        </span>
        {tool.slow && <span className="text-slate-400">~30–150s</span>}
        {!unlocked && tool.teaser && <span className="font-medium text-brand-600">1 free preview →</span>}
      </div>
    </Link>
  );
}
