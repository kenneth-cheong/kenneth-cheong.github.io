import { useAuth } from '../context/AuthContext.jsx';
import { PLANS } from '@shared/catalog.mjs';
import { Link } from 'react-router-dom';
import { Zap } from 'lucide-react';

export default function CreditMeter() {
  const { user } = useAuth();
  if (!user) return null;
  const max = PLANS[user.tier].monthlyCredits;
  const topup = user.topupCredits || 0;
  const pct = Math.max(0, Math.min(100, (user.credits / Math.max(max, user.credits)) * 100));
  const low = user.credits <= max * 0.2;

  return (
    <Link to="/usage" data-tour="credits" className="group flex items-center gap-3" title="View usage">
      <Zap size={18} className="text-amber-500" aria-hidden />
      <div className="w-32">
        <div className="flex justify-between text-xs font-medium text-slate-500">
          <span className={low ? 'text-amber-600' : ''}>
            {user.credits.toLocaleString()}
            {topup > 0 && <span className="text-brand-500"> (+{topup.toLocaleString()})</span>}
          </span>
          <span>{max.toLocaleString()}</span>
        </div>
        <div className="mt-0.5 h-1.5 overflow-hidden rounded-full bg-slate-200">
          <div
            className={`h-full rounded-full transition-all ${low ? 'bg-amber-500' : 'bg-brand-500'}`}
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>
    </Link>
  );
}
