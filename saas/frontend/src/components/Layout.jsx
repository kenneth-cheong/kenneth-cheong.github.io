import { useEffect, useRef, useState } from 'react';
import { Link, NavLink, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import { useSupportTickets } from '../context/SupportTicketsContext.jsx';
import CreditMeter from './CreditMeter.jsx';
import ChatDrawer from './ChatDrawer.jsx';
import Mascot from './Mascot.jsx';
import NotificationBell from './NotificationBell.jsx';
import PlanWidget from './PlanWidget.jsx';
import Toaster from './Toaster.jsx';
import ExplainMenu from './ExplainMenu.jsx';
import ProjectSelector from './ProjectSelector.jsx';
import Welcome from './Welcome.jsx';
import ConsentGate from './ConsentGate.jsx';
import TrialNdaGate from './TrialNdaGate.jsx';
import FaultReporter from './FaultReporter.jsx';
import { setUser as setDiagnosticsUser } from '../lib/diagnostics.js';
import { useMediaQuery, needsWelcome, hasAcceptedTerms, hasAcceptedNda } from '../lib/ui.js';
import { PLANS } from '@shared/catalog.mjs';
import { startPlatformTour, hasSeen, markSeen } from '../lib/tours.js';
import { Menu, HelpCircle, ChevronDown, ChevronLeft } from 'lucide-react';

// Core workflow links stay in the top bar; account/meta links live in the
// right-side account dropdown so the row never overflows.
const primaryNav = [
  { to: '/', label: 'Tools', end: true },
  { to: '/projects', label: 'Projects' },
  { to: '/schedules', label: 'Schedules' },
];
const menuNav = [
  { to: '/account', label: 'Account' },
  { to: '/integrations', label: 'Integrations' },
  { to: '/profile', label: 'Profile' },
  { to: '/account#billing', label: 'Billing' },
  { to: '/usage', label: 'Usage' },
  { to: '/pricing', label: 'Pricing' },
  { to: '/support', label: 'Support' },
];

// Red count pill for unanswered support tickets, shown beside the Admin link.
// Mirrors the NotificationBell badge so the whole app speaks one visual language.
function TicketBadge({ count }) {
  if (!count) return null;
  return (
    <span className="ml-1.5 inline-grid h-4 min-w-4 place-items-center rounded-full bg-red-500 px-1 text-[10px] font-bold text-white align-middle" title={`${count} support ticket${count === 1 ? '' : 's'} awaiting a reply`}>
      {count > 9 ? '9+' : count}
    </span>
  );
}

// User-resizable assistant panel. 384px is the default; drag the panel's left
// edge to change it (ChatDrawer reports new widths via onResize). The width is
// shared with the page margin below so content always tracks the panel.
const CHAT_W_DEFAULT = 384;
const CHAT_W_MIN = 320;
const CHAT_W_MAX = 720;
const clampChatW = (w) => Math.min(CHAT_W_MAX, Math.max(CHAT_W_MIN, Math.round(w)));

export default function Layout({ children }) {
  const { user, logout, setOnboarding } = useAuth();
  const { unanswered } = useSupportTickets();
  const location = useLocation();
  const { fromProjectId, fromProjectName } = location.state || {};
  const [chatOpen, setChatOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [acctOpen, setAcctOpen] = useState(false);
  const [ask, setAsk] = useState(null);
  const wide = useMediaQuery('(min-width: 768px)');
  // Persisted, user-adjustable width for the assistant panel (desktop only).
  const [chatW, setChatW] = useState(() => {
    const saved = Number(localStorage.getItem('dm:chatWidth'));
    return clampChatW(Number.isFinite(saved) && saved > 0 ? saved : CHAT_W_DEFAULT);
  });
  useEffect(() => { localStorage.setItem('dm:chatWidth', String(chatW)); }, [chatW]);
  // Stamp identity onto fault reports so support can tie a report to an account.
  useEffect(() => { setDiagnosticsUser(user); }, [user]);
  // Shows automatically for brand-new accounts; `?welcome=1` re-opens it anytime
  // (lets anyone replay the intro — tours were otherwise one-shot).
  const [forceWelcome, setForceWelcome] = useState(() => new URLSearchParams(window.location.search).has('welcome'));
  // Legal consent comes first: until the user accepts the current Terms version,
  // the consent gate is shown and the welcome flow / tour are held back so the
  // two overlays never stack.
  const needsConsent = !!user && !hasAcceptedTerms(user);
  // Soft-launch Free Trial + NDA gate — shown after base Terms consent, before
  // the welcome flow, so the overlays never stack.
  const needsNda = !!user && !needsConsent && !hasAcceptedNda(user);
  const showWelcome = !needsConsent && !needsNda && (forceWelcome || needsWelcome(user));

  // After the welcome flow is done → auto-run the platform tour once the
  // dashboard has painted. Chained behind the welcome so the two never stack;
  // `seenPlatformTour` is also tracked server-side so it survives a new device.
  useEffect(() => {
    if (needsConsent || needsNda || showWelcome) return;      // wait until consent + NDA + welcome are done
    if (hasSeen('platform') || user?.onboarding?.seenPlatformTour) return;
    if (window.location.pathname !== '/') return;
    const t = setTimeout(() => {
      if (!hasSeen('platform')) { markSeen('platform'); setOnboarding({ seenPlatformTour: true }); startPlatformTour(); }
    }, 900);
    return () => clearTimeout(t);
  }, [showWelcome, needsConsent, needsNda]); // eslint-disable-line react-hooks/exhaustive-deps

  // Launch the assistant on entry: open it (with its slide-in animation) once
  // per app load, after the consent/NDA/welcome overlays clear so it never
  // stacks on them. Desktop only — the panel sits beside content there, whereas
  // on mobile it's a full-screen sheet that would take over the whole app.
  // Users can opt out via the assistant's settings (dm:chatAutoOpen = '0').
  const autoLaunchedRef = useRef(false);
  useEffect(() => {
    if (autoLaunchedRef.current) return;
    if (!wide) return;
    if (needsConsent || needsNda || showWelcome) return;
    if (localStorage.getItem('dm:chatAutoOpen') === '0') return;
    autoLaunchedRef.current = true;
    setChatOpen(true);
  }, [wide, needsConsent, needsNda, showWelcome]);

  // Let any page open the assistant (Support CTA) or ask it about something
  // (the right-click "Explain this" menu).
  useEffect(() => {
    const open = () => setChatOpen(true);
    const onAsk = (e) => { setChatOpen(true); setAsk({ text: e.detail?.text || '', id: Math.random().toString(36).slice(2) }); };
    window.addEventListener('dm:open-chat', open);
    window.addEventListener('dm:ask', onAsk);
    return () => { window.removeEventListener('dm:open-chat', open); window.removeEventListener('dm:ask', onAsk); };
  }, []);

  const acctLinks = user.isAdmin ? [...menuNav, { to: '/admin', label: 'Admin' }] : menuNav;
  const allLinks = [...primaryNav, ...acctLinks]; // for the mobile sheet
  const linkCls = ({ isActive }) =>
    `rounded-lg px-3 py-1.5 text-sm font-medium ${isActive ? 'bg-brand-50 text-brand-700' : 'text-slate-600 hover:bg-slate-100'}`;

  return (
    <>
      {/* On desktop the page shifts left so chat sits beside content; on mobile
          the chat is a full-screen sheet, so no shift. */}
      <div className="min-h-screen transition-[margin] duration-200" style={{ marginRight: chatOpen && wide ? chatW : 0 }}>
        <header className="sticky top-0 z-20 border-b border-slate-200 bg-white/90 backdrop-blur">
          <div className="mx-auto flex max-w-6xl items-center gap-4 px-4 py-3">
            <button className="md:hidden" onClick={() => setMenuOpen((o) => !o)} aria-label="Menu">
              <Menu size={22} aria-hidden />
            </button>
            <Link to="/" className="flex shrink-0 items-center gap-2 font-bold text-brand-700" onClick={() => setMenuOpen(false)}>
              <span className="grid h-7 w-7 place-items-center rounded-md bg-brand-600 text-white">D</span>
              <span className="hidden sm:inline">Digimetrics</span>
            </Link>
            <nav className="hidden min-w-0 gap-1 md:flex">
              {primaryNav.map((n) => <NavLink key={n.to} to={n.to} end={n.end} data-tour={`nav-${n.to}`} className={linkCls}>{n.label}</NavLink>)}
            </nav>
            <div className="ml-auto flex shrink-0 items-center gap-2 sm:gap-3">
              <ProjectSelector />
              <PlanWidget />
              <CreditMeter />
              <NotificationBell />
              <button
                onClick={() => setChatOpen((o) => !o)}
                data-tour="assistant"
                title={chatOpen ? 'Close the Helpful Otter' : 'Open the Helpful Otter'}
                aria-label={chatOpen ? 'Close the Helpful Otter assistant' : 'Open the Helpful Otter assistant'}
                className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-semibold ${chatOpen ? 'bg-brand-600 text-white' : 'bg-slate-100 text-slate-700 hover:bg-slate-200'}`}
              >
                {/* Bare otter (no background circle) so it can go bigger and sit
                    directly on the button; slight negative margin keeps the row height. */}
                <Mascot bare size={42} className="shrink-0 -my-0.5" />
                <span className="hidden leading-[1.05] lg:flex lg:flex-col lg:items-start text-[12px] font-semibold">
                  <span>Helpful</span>
                  <span>Otter</span>
                </span>
              </button>

              <button
                onClick={startPlatformTour}
                data-tour="help"
                title="Take the platform tour"
                aria-label="Take the platform tour"
                className="hidden h-8 w-8 shrink-0 place-items-center rounded-full bg-slate-100 text-slate-600 hover:bg-slate-200 sm:grid"
              >
                <HelpCircle size={18} aria-hidden />
              </button>

              {/* Account dropdown (desktop) — holds Account/Usage/Pricing/Support/Admin + Sign out */}
              <div className="relative hidden md:block">
                <button
                  onClick={() => setAcctOpen((o) => !o)}
                  data-tour="account-menu"
                  className="flex items-center gap-1.5 rounded-lg py-1 pl-1 pr-1.5 hover:bg-slate-100"
                  title="Account, usage, billing & settings"
                  aria-label="Account menu"
                >
                  {user.picture ? (
                    <img
                      src={user.picture}
                      alt=""
                      referrerPolicy="no-referrer"
                      onError={(e) => { e.currentTarget.style.display = 'none'; }}
                      className="h-7 w-7 rounded-full object-cover"
                    />
                  ) : (
                    <span className="grid h-7 w-7 place-items-center rounded-full bg-brand-100 text-sm font-semibold text-brand-700">
                      {(user.name || user.email || '?').trim().charAt(0).toUpperCase()}
                    </span>
                  )}
                  <ChevronDown size={14} className="text-slate-400" aria-hidden />
                </button>
                {acctOpen && (
                  <>
                    <div className="fixed inset-0 z-10" onClick={() => setAcctOpen(false)} />
                    <div className="absolute right-0 z-20 mt-2 w-52 rounded-xl border border-slate-200 bg-white py-1.5 shadow-lg">
                      <div className="border-b border-slate-100 px-3 pb-2 pt-1">
                        <div className="truncate text-sm font-medium text-slate-700">{user.name || user.email}</div>
                        <div className="mt-0.5 inline-block rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                          {PLANS[user.tier].name} plan
                        </div>
                      </div>
                      {acctLinks.map((n) => (
                        <NavLink
                          key={n.to}
                          to={n.to}
                          onClick={() => setAcctOpen(false)}
                          className={({ isActive }) => `block px-3 py-1.5 text-sm ${isActive ? 'font-medium text-brand-700' : 'text-slate-600 hover:bg-slate-50'}`}
                        >
                          {n.label}
                          {n.to === '/admin' && <TicketBadge count={unanswered} />}
                        </NavLink>
                      ))}
                      <button onClick={logout} className="mt-1 block w-full border-t border-slate-100 px-3 py-2 text-left text-sm text-slate-500 hover:bg-slate-50">
                        Sign out
                      </button>
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>

          {/* Back-to-project strip — lives on its own row below the nav so it
              never gets clipped by the crowded top bar. */}
          {fromProjectId && (
            <div className="border-t border-slate-100">
              <div className="mx-auto max-w-6xl px-4 py-2">
                <Link
                  to={`/projects/${encodeURIComponent(fromProjectId)}`}
                  className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-sm font-medium text-brand-600 hover:bg-brand-50"
                >
                  <ChevronLeft size={14} aria-hidden />
                  Back to {fromProjectName || 'Project'}
                </Link>
              </div>
            </div>
          )}

          {/* Mobile menu — all links + sign out */}
          {menuOpen && (
            <nav className="flex flex-col border-t border-slate-100 px-4 py-2 md:hidden">
              {allLinks.map((n) => (
                <NavLink key={n.to} to={n.to} end={n.end} onClick={() => setMenuOpen(false)} className={linkCls}>
                  {n.label}
                  {n.to === '/admin' && <TicketBadge count={unanswered} />}
                </NavLink>
              ))}
              <button onClick={logout} className="mt-1 px-3 py-1.5 text-left text-sm text-slate-500">Sign out</button>
            </nav>
          )}
        </header>
        {user?.pastDue && (
          <div className="border-b border-amber-200 bg-amber-50">
            <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-2 px-4 py-2.5 text-sm text-amber-800">
              <span>⚠️ Your last payment failed — update your card to keep your plan active.</span>
              <Link to="/account" className="ml-auto font-semibold text-amber-900 underline">Update billing</Link>
            </div>
          </div>
        )}
        <main className="dm-main mx-auto max-w-6xl px-4 py-8">{children}</main>
      </div>

      <ChatDrawer
        open={chatOpen}
        onClose={() => setChatOpen(false)}
        width={wide ? chatW : '100%'}
        onResize={wide ? (w) => setChatW(clampChatW(w)) : undefined}
        ask={ask}
      />
      <ExplainMenu />
      <FaultReporter />
      <Toaster />
      {needsConsent && <ConsentGate />}
      {needsNda && <TrialNdaGate />}
      {showWelcome && <Welcome onDone={() => setForceWelcome(false)} />}
    </>
  );
}
