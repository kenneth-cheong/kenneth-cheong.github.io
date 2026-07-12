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
import ProactiveEngine from './ProactiveEngine.jsx';
import ProjectSelector from './ProjectSelector.jsx';
import ThemeToggle from './ThemeToggle.jsx';
import Welcome from './Welcome.jsx';
import ConsentGate from './ConsentGate.jsx';
import TrialNdaGate from './TrialNdaGate.jsx';
import FaultReporter from './FaultReporter.jsx';
import { setUser as setDiagnosticsUser } from '../lib/diagnostics.js';
import { identify as identifyRecording } from '../lib/analytics.js';
import { useMediaQuery, needsWelcome, hasAcceptedTerms, hasAcceptedNda } from '../lib/ui.js';
import { PLANS } from '@shared/catalog.mjs';
import { startPlatformTour, hasSeen, markSeen } from '../lib/tours.js';
import { Menu, HelpCircle, ChevronDown, ChevronLeft } from 'lucide-react';

// Core workflow links stay in the top bar; account/meta links live in the
// right-side account dropdown so the row never overflows. Labels are jobs, not
// system nouns ("Connect your data", not "Integrations").
const primaryNav = [
  { to: '/', label: 'Home', end: true },
  { to: '/projects', label: 'Projects' },
  { to: '/schedules', label: 'Schedules' },
];
// The recurring "check on my site" surfaces — previously reachable only via
// deep links from the dashboard/projects, i.e. invisible to anyone who didn't
// remember the path. Grouped under one labelled Monitor menu in the top bar.
const monitorNav = [
  { to: '/audit', label: 'Site Health Check' },
  { to: '/tracking', label: 'Rank Tracking' },
  { to: '/performance', label: 'Performance' },
];
const menuNav = [
  { to: '/account', label: 'Account & billing' },
  { to: '/integrations', label: 'Connect your data' },
  { to: '/profile', label: 'Profile' },
  { to: '/usage', label: 'Credits & usage' },
  { to: '/pricing', label: 'Plans & pricing' },
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
  const [say, setSay] = useState(null); // proactive canned message to inject into the chat
  const wide = useMediaQuery('(min-width: 768px)');
  // Persisted, user-adjustable width for the assistant panel (desktop only).
  const [chatW, setChatW] = useState(() => {
    const saved = Number(localStorage.getItem('dm:chatWidth'));
    return clampChatW(Number.isFinite(saved) && saved > 0 ? saved : CHAT_W_DEFAULT);
  });
  useEffect(() => { localStorage.setItem('dm:chatWidth', String(chatW)); }, [chatW]);
  // Stamp identity onto fault reports so support can tie a report to an account,
  // and onto the session recording so a tester's runs are findable by email.
  useEffect(() => { setDiagnosticsUser(user); identifyRecording(user); }, [user]);
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

  // After the welcome flow is done → OFFER the platform tour instead of
  // auto-running it. Fourteen steps force-firing on top of a just-dismissed
  // welcome (plus the auto-opened chat) was overload; a small invitation the
  // user can accept or wave away respects their pace. Either choice marks the
  // tour seen (server-side too) so it never nags again — it stays replayable
  // from the "?" help menu.
  const [tourOffer, setTourOffer] = useState(false);
  useEffect(() => {
    if (needsConsent || needsNda || showWelcome) return;      // wait until consent + NDA + welcome are done
    if (hasSeen('platform') || user?.onboarding?.seenPlatformTour) return;
    if (window.location.pathname !== '/') return;
    const t = setTimeout(() => { if (!hasSeen('platform')) setTourOffer(true); }, 900);
    return () => clearTimeout(t);
  }, [showWelcome, needsConsent, needsNda]); // eslint-disable-line react-hooks/exhaustive-deps
  const settleTourOffer = (take) => {
    markSeen('platform');
    setOnboarding({ seenPlatformTour: true });
    setTourOffer(false);
    if (take) startPlatformTour();
  };

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
    // Proactive Otter: a canned message to drop into the chat (no LLM call).
    const onSay = (e) => { setChatOpen(true); setSay({ text: e.detail?.text || '', id: Math.random().toString(36).slice(2) }); };
    window.addEventListener('dm:open-chat', open);
    window.addEventListener('dm:ask', onAsk);
    window.addEventListener('dm:proactive-say', onSay);
    return () => { window.removeEventListener('dm:open-chat', open); window.removeEventListener('dm:ask', onAsk); window.removeEventListener('dm:proactive-say', onSay); };
  }, []);

  const acctLinks = user.isAdmin ? [...menuNav, { to: '/admin', label: 'Admin' }] : menuNav;
  const linkCls = ({ isActive }) =>
    `rounded-lg px-3 py-1.5 text-sm font-medium ${isActive ? 'bg-brand-50 dark:bg-brand-500/10 text-brand-700 dark:text-brand-300' : 'text-dim hover:bg-sunken'}`;
  const [monitorOpen, setMonitorOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const onMonitorPage = monitorNav.some((n) => location.pathname.startsWith(n.to));

  return (
    <>
      {/* On desktop the page shifts left so chat sits beside content; on mobile
          the chat is a full-screen sheet, so no shift. */}
      <div className="min-h-screen transition-[margin] duration-200" style={{ marginRight: chatOpen && wide ? chatW : 0 }}>
        <header className="sticky top-0 z-20 border-b border-line bg-surface/90 backdrop-blur">
          <div className="mx-auto flex max-w-6xl items-center gap-4 px-4 py-3">
            <button className="md:hidden" onClick={() => setMenuOpen((o) => !o)} aria-label="Menu">
              <Menu size={22} aria-hidden />
            </button>
            <Link to="/" className="flex shrink-0 items-center gap-2 font-bold text-brand-700 dark:text-brand-300" onClick={() => setMenuOpen(false)}>
              <span className="grid h-7 w-7 place-items-center rounded-md bg-brand-600 text-white">D</span>
              <span className="hidden sm:inline">Digimetrics</span>
            </Link>
            <nav className="hidden min-w-0 items-center gap-1 md:flex">
              <NavLink to="/" end data-tour="nav-/" className={linkCls}>Home</NavLink>
              {/* Monitor menu — the recurring "how is my site doing?" surfaces. */}
              <div className="relative">
                <button
                  type="button"
                  onClick={() => setMonitorOpen((o) => !o)}
                  data-tour="nav-monitor"
                  className={`flex items-center gap-1 rounded-lg px-3 py-1.5 text-sm font-medium ${onMonitorPage ? 'bg-brand-50 dark:bg-brand-500/10 text-brand-700 dark:text-brand-300' : 'text-dim hover:bg-sunken'}`}
                >
                  Monitor <ChevronDown size={13} className="text-faint" aria-hidden />
                </button>
                {monitorOpen && (
                  <>
                    <div className="fixed inset-0 z-10" onClick={() => setMonitorOpen(false)} />
                    <div className="absolute left-0 z-20 mt-2 w-48 rounded-xl border border-line bg-surface py-1.5 shadow-lg">
                      {monitorNav.map((n) => (
                        <NavLink key={n.to} to={n.to} onClick={() => setMonitorOpen(false)}
                          className={({ isActive }) => `block px-3 py-1.5 text-sm ${isActive ? 'font-medium text-brand-700 dark:text-brand-300' : 'text-dim hover:bg-raised'}`}>
                          {n.label}
                        </NavLink>
                      ))}
                    </div>
                  </>
                )}
              </div>
              {primaryNav.slice(1).map((n) => <NavLink key={n.to} to={n.to} end={n.end} data-tour={`nav-${n.to}`} className={linkCls}>{n.label}</NavLink>)}
            </nav>
            <div className="ml-auto flex shrink-0 items-center gap-2 sm:gap-3">
              <ProjectSelector />
              <PlanWidget />
              <CreditMeter />
              <NotificationBell />
              <button
                onClick={() => setChatOpen((o) => !o)}
                data-tour="assistant"
                title={chatOpen ? 'Close Monty' : 'Open Monty'}
                aria-label={chatOpen ? 'Close Monty the assistant' : 'Open Monty the assistant'}
                className={`inline-flex h-9 items-center gap-1.5 rounded-lg px-2.5 text-sm font-semibold ${chatOpen ? 'bg-brand-600 text-white' : 'bg-sunken text-body hover:bg-overlay'}`}
              >
                {/* Bare otter (no background circle). Sized to fit the fixed button
                    height so this matches the "Up next" pill in the header row. */}
                <Mascot bare size={30} className="shrink-0" />
                <span className="hidden text-[13px] font-semibold lg:inline">Monty</span>
              </button>

              {/* Help menu — visible on every screen size (the tour used to hide
                  behind an unlabelled desktop-only icon). One place for "show me
                  around", the assistant, and human support. */}
              <div className="relative shrink-0">
                <button
                  onClick={() => setHelpOpen((o) => !o)}
                  data-tour="help"
                  title="Help — tour, assistant & support"
                  aria-label="Help menu"
                  className="grid h-8 w-8 place-items-center rounded-full bg-sunken text-dim hover:bg-overlay"
                >
                  <HelpCircle size={18} aria-hidden />
                </button>
                {helpOpen && (
                  <>
                    <div className="fixed inset-0 z-10" onClick={() => setHelpOpen(false)} />
                    <div className="absolute right-0 z-20 mt-2 w-56 rounded-xl border border-line bg-surface py-1.5 shadow-lg">
                      <button type="button" onClick={() => { setHelpOpen(false); startPlatformTour(); }}
                        className="block w-full px-3 py-1.5 text-left text-sm text-dim hover:bg-raised">
                        Show me around (2-min tour)
                      </button>
                      <button type="button" onClick={() => { setHelpOpen(false); setChatOpen(true); }}
                        className="block w-full px-3 py-1.5 text-left text-sm text-dim hover:bg-raised">
                        Ask Monty a question
                      </button>
                      <Link to="/support" onClick={() => setHelpOpen(false)}
                        className="block px-3 py-1.5 text-sm text-dim hover:bg-raised">
                        Contact support
                      </Link>
                    </div>
                  </>
                )}
              </div>

              <ThemeToggle className="hidden sm:grid" tourId="theme" />

              {/* Account dropdown (desktop) — holds Account/Usage/Pricing/Support/Admin + Sign out */}
              <div className="relative hidden md:block">
                <button
                  onClick={() => setAcctOpen((o) => !o)}
                  data-tour="account-menu"
                  className="flex items-center gap-1.5 rounded-lg py-1 pl-1 pr-1.5 hover:bg-sunken"
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
                    <span className="grid h-7 w-7 place-items-center rounded-full bg-brand-100 dark:bg-brand-500/15 text-sm font-semibold text-brand-700 dark:text-brand-300">
                      {(user.name || user.email || '?').trim().charAt(0).toUpperCase()}
                    </span>
                  )}
                  <ChevronDown size={14} className="text-faint" aria-hidden />
                </button>
                {acctOpen && (
                  <>
                    <div className="fixed inset-0 z-10" onClick={() => setAcctOpen(false)} />
                    <div className="absolute right-0 z-20 mt-2 w-52 rounded-xl border border-line bg-surface py-1.5 shadow-lg">
                      <div className="border-b border-hair px-3 pb-2 pt-1">
                        <div className="truncate text-sm font-medium text-body">{user.name || user.email}</div>
                        <div className="mt-0.5 inline-block rounded-full bg-sunken px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted">
                          {PLANS[user.tier].name} plan
                        </div>
                      </div>
                      {acctLinks.map((n) => (
                        <NavLink
                          key={n.to}
                          to={n.to}
                          onClick={() => setAcctOpen(false)}
                          className={({ isActive }) => `block px-3 py-1.5 text-sm ${isActive ? 'font-medium text-brand-700 dark:text-brand-300' : 'text-dim hover:bg-raised'}`}
                        >
                          {n.label}
                          {n.to === '/admin' && <TicketBadge count={unanswered} />}
                        </NavLink>
                      ))}
                      <button onClick={logout} className="mt-1 block w-full border-t border-hair px-3 py-2 text-left text-sm text-muted hover:bg-raised">
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
            <div className="border-t border-hair">
              <div className="mx-auto max-w-6xl px-4 py-2">
                <Link
                  to={`/projects/${encodeURIComponent(fromProjectId)}`}
                  className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-sm font-medium text-brand-600 dark:text-brand-400 hover:bg-brand-50 dark:hover:bg-brand-500/10"
                >
                  <ChevronLeft size={14} aria-hidden />
                  Back to {fromProjectName || 'Project'}
                </Link>
              </div>
            </div>
          )}

          {/* Mobile menu — grouped by job (was one flat 11-row list) + sign out */}
          {menuOpen && (
            <nav className="flex flex-col border-t border-hair px-4 py-2 md:hidden">
              {primaryNav.map((n) => (
                <NavLink key={n.to} to={n.to} end={n.end} onClick={() => setMenuOpen(false)} className={linkCls}>
                  {n.label}
                </NavLink>
              ))}
              <div className="mt-2 px-3 text-[11px] font-semibold uppercase tracking-wide text-faint">Monitor</div>
              {monitorNav.map((n) => (
                <NavLink key={n.to} to={n.to} onClick={() => setMenuOpen(false)} className={linkCls}>
                  {n.label}
                </NavLink>
              ))}
              <div className="mt-2 px-3 text-[11px] font-semibold uppercase tracking-wide text-faint">Account</div>
              {acctLinks.map((n) => (
                <NavLink key={n.to} to={n.to} onClick={() => setMenuOpen(false)} className={linkCls}>
                  {n.label}
                  {n.to === '/admin' && <TicketBadge count={unanswered} />}
                </NavLink>
              ))}
              <button
                type="button"
                onClick={() => { setMenuOpen(false); startPlatformTour(); }}
                className="mt-1 rounded-lg px-3 py-1.5 text-left text-sm font-medium text-dim hover:bg-sunken"
              >
                Show me around (2-min tour)
              </button>
              <div className="mt-1 flex items-center gap-2 px-3 py-1.5">
                <ThemeToggle />
                <span className="text-sm text-dim">Theme</span>
              </div>
              <button onClick={logout} className="mt-1 px-3 py-1.5 text-left text-sm text-muted">Sign out</button>
            </nav>
          )}
        </header>
        {user?.pastDue && (
          <div className="border-b border-amber-200 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-500/10">
            <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-2 px-4 py-2.5 text-sm text-amber-800 dark:text-amber-300">
              <span>⚠️ Your last payment failed — update your card to keep your plan active.</span>
              <Link to="/account" className="ml-auto font-semibold text-amber-900 dark:text-amber-200 underline">Update billing</Link>
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
        say={say}
      />
      {/* Proactive Helpful Otter — desktop only (mobile chat is a full-screen sheet
          it shouldn't hijack). Suppressed until the consent/NDA/welcome overlays clear. */}
      {wide && <ProactiveEngine paused={needsConsent || needsNda || showWelcome} chatOpen={chatOpen} />}
      <ExplainMenu />
      <FaultReporter />
      <Toaster />
      {needsConsent && <ConsentGate />}
      {needsNda && <TrialNdaGate />}
      {showWelcome && <Welcome onDone={() => setForceWelcome(false)} />}

      {/* Friendly one-time tour invitation (replaces the old auto-fired tour). */}
      {tourOffer && (
        <div className="fixed bottom-4 left-1/2 z-40 w-[calc(100%-2rem)] max-w-md -translate-x-1/2 rounded-2xl border border-line bg-surface p-4 shadow-xl">
          <div className="flex items-start gap-3">
            <Mascot bare size={40} className="shrink-0" />
            <div className="min-w-0">
              <p className="text-sm font-semibold text-heading">New here? Want a quick look around?</p>
              <p className="mt-0.5 text-xs text-dim">A 2-minute tour of the essentials — you can replay it anytime from the “?” button up top.</p>
              <div className="mt-2.5 flex gap-2">
                <button type="button" onClick={() => settleTourOffer(true)} className="btn-primary px-3 py-1.5 text-xs">Show me around</button>
                <button type="button" onClick={() => settleTourOffer(false)} className="btn-ghost px-3 py-1.5 text-xs">Maybe later</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
