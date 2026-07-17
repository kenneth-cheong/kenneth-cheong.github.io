import { useEffect, useState } from 'react';
import { NavLink, Link } from 'react-router-dom';
import {
  LayoutGrid, FolderKanban, HeartPulse, TrendingUp, LineChart,
  CalendarClock, Plug, Settings, Shield, Check, LayoutList,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext.jsx';
import { useSupportTickets } from '../context/SupportTicketsContext.jsx';
import { PLANS, TOOLS, tierMeets } from '@shared/catalog.mjs';
import Mascot from './Mascot.jsx';
import Modal from './Modal.jsx';
import ToolsModal from './ToolsModal.jsx';

// The approved design's fixed left rail (mockup .sidebar). Replacing the top bar
// buys real estate: every "Monitor" destination that used to hide behind a
// dropdown is now a first-class row, and the header stops fighting for width.
//
// `data-tour` anchors are carried over from the old top nav — the platform tour
// hangs off these ids, so renaming one silently breaks a step.
const NAV = [
  { to: '/', label: 'Home', icon: LayoutGrid, end: true, tour: 'nav-/' },
  { to: '/projects', label: 'Projects', icon: FolderKanban, tour: 'nav-/projects' },
  { to: '/audit', label: 'Site Health', icon: HeartPulse, tour: 'nav-monitor' },
  { to: '/tracking', label: 'Rank Tracking', icon: TrendingUp },
  { to: '/performance', label: 'Performance', icon: LineChart },
  { to: '/schedules', label: 'Schedules', icon: CalendarClock, tour: 'nav-/schedules' },
  { to: '/integrations', label: 'Connect data', icon: Plug },
  // No `tour` here — the header's account dropdown already owns 'account-menu',
  // and driver.js resolves a duplicate anchor to whichever comes first in DOM.
  { to: '/account', label: 'Settings', icon: Settings },
];

export default function Sidebar({ open, onNavigate, onOpenChat }) {
  const { user } = useAuth();
  const { unanswered } = useSupportTickets();
  const [planOpen, setPlanOpen] = useState(false);
  const [toolsOpen, setToolsOpen] = useState(false);
  // Let any page open the rail's popups (the welcome banner and attention strip
  // both pitch upgrades) — same window-event idiom as dm:open-chat/dm:open-tools.
  useEffect(() => {
    const tools = () => setToolsOpen(true);
    const plan = () => setPlanOpen(true);
    window.addEventListener('dm:open-tools', tools);
    window.addEventListener('dm:open-plan', plan);
    return () => { window.removeEventListener('dm:open-tools', tools); window.removeEventListener('dm:open-plan', plan); };
  }, []);
  if (!user) return null;

  const max = PLANS[user.tier].monthlyCredits;
  const total = user.credits || 0;
  const topup = user.topupCredits || 0;
  const pct = Math.max(0, Math.min(100, (total / Math.max(max, total, 1)) * 100));
  const low = total <= max * 0.2;
  const renews = user.periodEnd
    ? new Date(user.periodEnd).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
    : null;
  // Tiers above the current one — what "upgrade" actually offers this account.
  const upgrades = Object.values(PLANS).filter((p) => !tierMeets(user.tier, p.id) && p.id !== user.tier);

  const item = ({ isActive }) =>
    `dm-sb-item ${isActive ? 'dm-sb-item-on' : ''}`;

  return (
    <aside className={`dm-sidebar ${open ? 'dm-sidebar-open' : ''}`} aria-label="Main navigation">
      <Link to="/" onClick={onNavigate} className="mb-2 flex items-center gap-2.5 px-2 pb-4 pt-1">
        <span className="dm-brand-dot" aria-hidden />
        <b className="text-[13px] font-bold tracking-[0.2em] text-heading">
          DIGI<span className="text-pos">METRICS</span>
        </b>
      </Link>

      <nav className="flex flex-1 flex-col gap-[3px]">
        {NAV.map(({ to, label, icon: Icon, end, tour, badge }) => (
          <NavLink key={to} to={to} end={end} data-tour={tour} onClick={onNavigate} className={item}>
            <Icon size={18} aria-hidden className="dm-sb-ico shrink-0" />
            <span className="truncate">{label}</span>
            {badge ? <span className="dm-sb-badge">{badge}</span> : null}
          </NavLink>
        ))}
        {/* Mockup's rail has Tools as a peer of Home; here it opens the catalog
            popup rather than routing, since Home already lists the same tiles. */}
        <button type="button" onClick={() => setToolsOpen(true)} data-tour="tools" className="dm-sb-item w-full">
          <LayoutList size={18} aria-hidden className="dm-sb-ico shrink-0" />
          <span className="truncate">Tools</span>
          <span className="dm-sb-badge">{TOOLS.length}</span>
        </button>
        {user.isAdmin && (
          <NavLink to="/admin" onClick={onNavigate} className={item}>
            <Shield size={18} aria-hidden className="dm-sb-ico shrink-0" />
            <span className="truncate">Admin</span>
            {unanswered > 0 && <span className="dm-sb-badge !bg-red-500 !text-white">{unanswered > 9 ? '9+' : unanswered}</span>}
          </NavLink>
        )}
      </nav>

      {/* Credits — the mockup's .sb-credits block. Same numbers CreditMeter shows. */}
      <Link to="/usage" data-tour="credits" className="dm-sb-credits" onClick={onNavigate}>
        <div className="mb-2 flex justify-between text-[11px] font-semibold text-muted">
          <span>AI Credits</span>
          <b className={low ? 'text-warn' : 'text-heading'}>{total.toLocaleString()} left</b>
        </div>
        <div className="dm-sb-bar"><i style={{ width: `${pct}%` }} /></div>
      </Link>
      {/* Mirrors the mockup's sb-upgrade → subscription popup. */}
      <button type="button" onClick={() => setPlanOpen(true)} className="dm-sb-upgrade">Upgrade plan</button>

      <button type="button" onClick={onOpenChat} data-tour="assistant" className="dm-sb-monty">
        <Mascot bare size={32} className="shrink-0" />
        <span className="min-w-0 text-left">
          <span className="block truncate text-xs font-bold text-heading">Monty</span>
          <span className="block truncate text-[10px] text-muted">Ask anything</span>
        </span>
      </button>

      <ToolsModal open={toolsOpen} onClose={() => setToolsOpen(false)} />

      <Modal
        open={planOpen}
        onClose={() => setPlanOpen(false)}
        tag="PLAN"
        title="Subscription & credits"
        labelledBy="dm-plan-title"
        footer={
          <>
            <Link to="/pricing" onClick={() => { setPlanOpen(false); onNavigate?.(); }} className="btn-primary px-4 py-2 text-sm" data-autofocus>
              Compare all plans
            </Link>
            <Link to="/usage" onClick={() => { setPlanOpen(false); onNavigate?.(); }} className="btn-ghost px-4 py-2 text-sm">
              Credits & usage
            </Link>
          </>
        }
      >
        {/* Real figures — same source as the rail's meter, not a mock. */}
        <div className="grid grid-cols-3 gap-3">
          {[
            ['Current plan', PLANS[user.tier].name],
            ['Credits left', total.toLocaleString()],
            ['Monthly allowance', max.toLocaleString()],
          ].map(([k, v]) => (
            <div key={k} className="rounded-2xl border border-line bg-raised p-3.5">
              <div className="text-2xl font-extrabold tracking-tight text-heading">{v}</div>
              <div className="mt-0.5 text-[10px] font-semibold text-muted">{k}</div>
            </div>
          ))}
        </div>
        <div>
          <div className="dm-sb-bar"><i style={{ width: `${pct}%` }} /></div>
          <p className="mt-2 text-xs text-muted">
            {topup > 0 && <>Includes <b className="text-heading">{topup.toLocaleString()}</b> top-up credits that roll over. </>}
            {renews ? <>Monthly credits renew {renews}.</> : <>Credits renew each billing period.</>}
          </p>
        </div>

        {upgrades.length > 0 ? (
          <div className="flex flex-col gap-2">
            <span className="text-[10px] font-bold uppercase tracking-[0.18em] text-faint">Upgrade to</span>
            {upgrades.map((p) => (
              <div key={p.id} className="flex items-start gap-3 rounded-2xl border border-line bg-raised p-3.5">
                <Check size={15} className="mt-0.5 shrink-0 text-pos" aria-hidden />
                <div className="min-w-0">
                  <div className="text-sm font-bold text-heading">
                    {p.name} · {p.priceMonthly ? `$${p.priceMonthly}/mo` : 'Free'}
                    <span className="ml-2 font-semibold text-muted">{p.monthlyCredits.toLocaleString()} credits</span>
                  </div>
                  <p className="mt-0.5 text-xs text-muted">{p.blurb}</p>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-xs text-muted">You're on the top plan — nothing to upgrade to.</p>
        )}
      </Modal>
    </aside>
  );
}
