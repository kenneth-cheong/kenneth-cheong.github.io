import { useAuth } from '../context/AuthContext.jsx';
import { PLANS } from '@shared/catalog.mjs';
import { Link } from 'react-router-dom';
import { Zap } from 'lucide-react';

export default function CreditMeter() {
  const { user } = useAuth();
  if (!user) return null;
  const max = PLANS[user.tier].monthlyCredits;
  const total = user.credits || 0;             // total spendable (monthly + top-up)
  const topup = user.topupCredits || 0;
  const monthly = Math.max(0, total - topup);  // monthly bucket left (consistent with the fresh total)
  const pct = Math.max(0, Math.min(100, (total / Math.max(max, total, 1)) * 100));
  const low = total <= max * 0.2;
  const renews = user.periodEnd
    ? new Date(user.periodEnd).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
    : null;

  return (
    <Link to="/usage" data-tour="credits" className="group relative flex items-center gap-2 sm:gap-3" aria-label={`${total.toLocaleString()} credits left of ${max.toLocaleString()}`}>
      <Zap size={18} className="shrink-0 text-amber-500" aria-hidden />

      {/* Compact pill on phones — the header can't fit the labelled bar there. */}
      <span className={`text-xs font-semibold tabular-nums sm:hidden ${low ? 'text-amber-600 dark:text-amber-400' : 'text-body'}`}>
        {total.toLocaleString()} <span className="font-medium text-muted">credits</span>
      </span>

      {/* Full labelled meter — say the word "credits" up front, not on hover. */}
      <div className="hidden w-36 sm:block">
        <div className="flex justify-between text-xs font-medium text-muted">
          <span className={low ? 'text-amber-600 dark:text-amber-400' : ''}>
            {total.toLocaleString()} <span className="font-normal">credits</span>
          </span>
          <span>of {max.toLocaleString()}</span>
        </div>
        <div className="mt-0.5 h-1.5 overflow-hidden rounded-full bg-overlay">
          <div
            className={`h-full rounded-full transition-all ${low ? 'bg-amber-500' : 'bg-brand-500'}`}
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>

      {/* Hover breakdown — explains the monthly vs top-up split at a glance. */}
      <div className="pointer-events-none absolute right-0 top-full z-50 mt-2 w-60 rounded-xl border border-line bg-surface p-3 text-left text-xs opacity-0 shadow-xl transition-opacity duration-150 group-hover:opacity-100">
        <div className="pb-1.5 text-muted">Credits are what tool runs cost — most runs cost 1–5.</div>
        <div className="flex justify-between py-0.5">
          <span className="text-muted">Monthly left</span>
          <span className="font-semibold text-strong">{monthly.toLocaleString()} / {max.toLocaleString()}</span>
        </div>
        {topup > 0 && (
          <div className="flex justify-between py-0.5">
            <span className="text-muted">Top-up (rolls over)</span>
            <span className="font-semibold text-brand-600 dark:text-brand-400">+{topup.toLocaleString()}</span>
          </div>
        )}
        <div className="mt-1 flex justify-between border-t border-hair pt-1.5">
          <span className="text-muted">Total spendable</span>
          <span className="font-bold text-heading">{total.toLocaleString()}</span>
        </div>
        {renews && <div className="mt-1.5 text-faint">Monthly credits renew {renews}</div>}
        <div className="mt-1.5 font-medium text-brand-600 dark:text-brand-400">View usage →</div>
      </div>
    </Link>
  );
}
