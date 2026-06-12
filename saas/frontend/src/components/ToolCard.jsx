import { Link } from 'react-router-dom';
import { PLANS, CREDIT_COSTS, tierMeets } from '@shared/catalog.mjs';

// A tool tile. Locked tools STAY VISIBLE with a tier pill + lock — never hidden.
export default function ToolCard({ tool, userTier }) {
  const unlocked = tierMeets(userTier, tool.minTier);
  const cost = CREDIT_COSTS[tool.cost] ?? 0;

  return (
    <Link
      to={`/tool/${tool.id}`}
      className={`card group relative flex flex-col p-4 transition hover:shadow-md ${
        unlocked ? '' : 'border-dashed'
      }`}
    >
      <div className="flex items-start justify-between">
        <span className="rounded-md bg-slate-100 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
          {tool.category}
        </span>
        {!unlocked && (
          <span className="flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-bold uppercase text-amber-700">
            🔒 {PLANS[tool.minTier].name}
          </span>
        )}
      </div>
      <h3 className="mt-3 font-semibold text-slate-900 group-hover:text-brand-700">{tool.name}</h3>
      <p className="mt-1 flex-1 text-sm text-slate-500">{tool.desc}</p>
      <div className="mt-3 flex items-center justify-between text-xs text-slate-400">
        <span>{cost === 0 ? 'Free to run' : `${cost} credit${cost > 1 ? 's' : ''}/run`}</span>
        {!unlocked && tool.teaser && (
          <span className="font-medium text-brand-600">1 free preview →</span>
        )}
      </div>
    </Link>
  );
}
