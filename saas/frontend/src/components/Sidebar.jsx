import { useEffect, useState } from 'react';
import { NavLink, Link, useNavigate, useLocation } from 'react-router-dom';
import {
  LayoutGrid, FolderKanban, HeartPulse, TrendingUp, LineChart,
  CalendarClock, Plug, Settings, Shield, Check, LayoutList, Coins, ChevronRight,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext.jsx';
import { useSupportTickets } from '../context/SupportTicketsContext.jsx';
import { PLANS, TOOLS, CATEGORIES, CATEGORY_META, tierMeets } from '@shared/catalog.mjs';
import Logo from './Logo.jsx';
import Mascot from './Mascot.jsx';
import Modal from './Modal.jsx';

// The approved design's fixed left rail (mockup .sidebar). Grouped into labelled
// sections so the purpose of each row is obvious at a glance — you jump to the
// SECTION that matches your intent (see how I'm doing → Insights; get things done
// → Work; set up → Setup) instead of scanning ten equal rows.
//
// `data-tour` anchors are carried over from the old top nav — the platform tour
// hangs off these ids, so renaming one silently breaks a step.
const NAV_GROUPS = [
  { items: [
    { to: '/', label: 'Home', icon: LayoutGrid, end: true, tour: 'nav-/' },
  ] },
  { label: 'Insights', items: [
    // "Site Health Check" in full — the page, the share card and every mention
    // elsewhere use the full name, and the clipped rail label read as a third,
    // separate feature alongside the GEO+SEO Forensic Audit.
    { to: '/audit', label: 'Site Health Check', icon: HeartPulse, tour: 'nav-monitor' },
    { to: '/tracking', label: 'Rankings', icon: TrendingUp },
    { to: '/performance', label: 'Traffic', icon: LineChart },
  ] },
  { label: 'Work', items: [
    // Tools expands into the disciplines — each sub-row filters the catalogue to
    // that one discipline (/tools?category=…), so you can go straight to the SEO
    // shelf without scrolling past everything else.
    { to: '/tools', label: 'Tools', icon: LayoutList, tour: 'tools', badge: TOOLS.length, subs: CATEGORIES },
    { to: '/projects', label: 'Projects', icon: FolderKanban, tour: 'nav-/projects' },
    { to: '/schedules', label: 'Schedules', icon: CalendarClock, tour: 'nav-/schedules' },
  ] },
  { label: 'Setup', items: [
    { to: '/integrations', label: 'Connect data', icon: Plug },
    { to: '/account', label: 'Settings', icon: Settings },
  ] },
];

export default function Sidebar({ open, onNavigate, onOpenChat }) {
  const { user } = useAuth();
  const { unanswered } = useSupportTickets();
  const navigate = useNavigate();
  const location = useLocation();
  const [planOpen, setPlanOpen] = useState(false);
  // The discipline sub-menu opens itself while you're on the Tools page, and
  // stays wherever you last put it once you touch the chevron.
  const [subsPinned, setSubsPinned] = useState(null);
  const onTools = location.pathname === '/tools';
  const subsOpen = subsPinned === null ? onTools : subsPinned;
  const setSubsOpen = (v) => setSubsPinned(v);
  const activeCategory = onTools ? new URLSearchParams(location.search).get('category') : null;
  // Let any page trigger the rail's actions: "explore tools" now navigates to the
  // Tools page (it used to open a modal); the upgrade pitch opens the plan popup.
  // Same window-event idiom as dm:open-chat.
  useEffect(() => {
    const tools = () => navigate('/tools');
    const plan = () => setPlanOpen(true);
    window.addEventListener('dm:open-tools', tools);
    window.addEventListener('dm:open-plan', plan);
    return () => { window.removeEventListener('dm:open-tools', tools); window.removeEventListener('dm:open-plan', plan); };
  }, [navigate]);
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
        <Logo width={148} />
      </Link>

      <nav className="flex flex-1 flex-col gap-[3px]">
        {NAV_GROUPS.map((group, gi) => (
          <div key={gi} className={`flex flex-col gap-[3px] ${group.label ? 'mt-3' : ''}`}>
            {group.label && (
              <span className="px-3 pb-0.5 text-[9px] font-bold uppercase tracking-[0.16em] text-faint">{group.label}</span>
            )}
            {group.items.map(({ to, label, icon: Icon, end, tour, badge, subs }) => (
              <div key={to} className="flex flex-col gap-[3px]">
                <NavLink to={to} end={end} data-tour={tour} onClick={onNavigate} className={item}>
                  <Icon size={18} aria-hidden className="dm-sb-ico shrink-0" />
                  <span className="truncate">{label}</span>
                  {badge ? <span className="dm-sb-badge">{badge}</span> : null}
                  {subs && (
                    // Stops at the chevron: expanding the disciplines shouldn't
                    // also navigate you away from wherever you are.
                    <span
                      role="button"
                      tabIndex={0}
                      aria-label={subsOpen ? 'Collapse disciplines' : 'Expand disciplines'}
                      aria-expanded={subsOpen}
                      onClick={(e) => { e.preventDefault(); e.stopPropagation(); setSubsOpen(!subsOpen); }}
                      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); setSubsOpen(!subsOpen); } }}
                      className={`${badge ? '-ml-1' : 'ml-auto'} grid h-5 w-5 shrink-0 place-items-center rounded-md text-faint transition-colors hover:bg-overlay hover:text-strong`}
                    >
                      <ChevronRight size={14} aria-hidden className={`transition-transform ${subsOpen ? 'rotate-90' : ''}`} />
                    </span>
                  )}
                </NavLink>
                {subs && subsOpen && subs.map((c) => (
                  <NavLink
                    key={c}
                    to={`/tools?category=${encodeURIComponent(c)}`}
                    onClick={onNavigate}
                    className={`dm-sb-sub ${activeCategory === c ? 'dm-sb-sub-on' : ''}`}
                  >
                    <span className="dm-sb-dot" style={{ background: CATEGORY_META[c]?.color || 'currentColor' }} aria-hidden />
                    <span className="truncate">{c}</span>
                    <span className="ml-auto text-[10px] font-bold text-faint">
                      {TOOLS.filter((t) => t.category === c).length}
                    </span>
                  </NavLink>
                ))}
              </div>
            ))}
          </div>
        ))}
        {user.isAdmin && (
          <NavLink to="/admin" onClick={onNavigate} className={({ isActive }) => `${item({ isActive })} mt-3`}>
            <Shield size={18} aria-hidden className="dm-sb-ico shrink-0" />
            <span className="truncate">Admin</span>
            {unanswered > 0 && <span className="dm-sb-badge !bg-red-500 !text-white">{unanswered > 9 ? '9+' : unanswered}</span>}
          </NavLink>
        )}
      </nav>

      {/* The only surface that prices tools — tool tiles and tool pages stay quiet
          about credits so people choose by job, not by cost. It sits with the
          credits block rather than in the nav groups, and reads smaller than a
          nav row: it's a lookup you reach for occasionally, not a destination. */}
      <NavLink
        to="/credit-guide"
        onClick={onNavigate}
        className={({ isActive }) => `dm-sb-mini ${isActive ? 'dm-sb-mini-on' : ''}`}
      >
        <Coins size={14} aria-hidden className="shrink-0" />
        <span className="truncate">Credit guide</span>
      </NavLink>

      {/* Credits — the mockup's .sb-credits block. Same numbers CreditMeter shows. */}
      <Link to="/usage" data-tour="credits" className="dm-sb-credits !mt-1" onClick={onNavigate}>
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
            {topup > 0 && <>Includes <b className="text-heading">{topup.toLocaleString()}</b> top-up credits that roll over (valid 12 months). </>}
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
