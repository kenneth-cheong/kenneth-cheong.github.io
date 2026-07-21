import { useEffect, useRef, useState } from 'react';
import { Link, NavLink, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import { useSupportTickets } from '../context/SupportTicketsContext.jsx';
import ChatDrawer from './ChatDrawer.jsx';
import Mascot from './Mascot.jsx';
import NotificationBell from './NotificationBell.jsx';
import PlanWidget from './PlanWidget.jsx';
import PlanBreadcrumb from './PlanBreadcrumb.jsx';
import Toaster from './Toaster.jsx';
import ExplainMenu from './ExplainMenu.jsx';
import ProactiveEngine from './ProactiveEngine.jsx';
import ProjectSelector from './ProjectSelector.jsx';
import Sidebar from './Sidebar.jsx';
import MontyLauncher from './MontyLauncher.jsx';
import PlanPeek from './PlanPeek.jsx';
import ThemeToggle from './ThemeToggle.jsx';
import Welcome from './Welcome.jsx';
import ConsentGate from './ConsentGate.jsx';
import TrialNdaGate from './TrialNdaGate.jsx';
import FaultReporter from './FaultReporter.jsx';
import { setUser as setDiagnosticsUser } from '../lib/diagnostics.js';
import { identify as identifyRecording } from '../lib/analytics.js';
import { useMediaQuery, needsWelcome, hasAcceptedTerms, hasAcceptedNda, onboardingOf } from '../lib/ui.js';
import { PLANS } from '@shared/catalog.mjs';
import { startPlatformTour, hasSeen, markSeen } from '../lib/tours.js';
import { Menu, HelpCircle, ChevronDown, ChevronLeft, Search } from 'lucide-react';
import CommandPalette from './CommandPalette.jsx';

// Account/meta links live in the right-side account dropdown. The primary
// workflow nav moved to the fixed rail — see Sidebar.jsx for that list.
const menuNav = [
  { to: '/account', label: 'Account & billing' },
  { to: '/integrations', label: 'Connect your data' },
  { to: '/profile', label: 'Profile' },
  { to: '/notifications', label: 'Notifications' },
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
  // Stamp identity onto fault reports so support can tie a report to an account,
  // and onto the session recording so a tester's runs are findable by email.
  useEffect(() => { setDiagnosticsUser(user); identifyRecording(user); }, [user]);
  // Shows automatically for brand-new accounts; `?welcome=1` re-opens it anytime
  // (lets anyone replay the intro — tours were otherwise one-shot).
  const [forceWelcome, setForceWelcome] = useState(() => new URLSearchParams(window.location.search).has('welcome'));
  // ── Onboarding: ONE ask at a time, and never the same ask twice ────────────
  // This used to be a queue of four consecutive overlays (Terms consent → Free
  // Trial/NDA → welcome goal picker → tour offer), and because several of the
  // "seen it" flags were written fire-and-forget, a failed write put the whole
  // queue back on screen at the NEXT login. Users reported being "forced through
  // all the onboarding questions repeatedly".
  //
  // Now: the two legal acceptances share a single dialog (TrialNdaGate renders
  // the Terms checkbox via `withTerms`), and the tour offer is folded into the
  // welcome flow rather than firing as a separate toast behind it. So a brand-new
  // account sees at most two screens ever — the legal gate, then the welcome —
  // and a returning user sees none.
  // ...EXCEPT on the legal pages themselves. The gate asks you to agree to the
  // Terms and Privacy Notice and links to them — but those links land back in
  // this same Layout, which re-rendered the gate ON TOP of the document, so the
  // reader got the pop-up again instead of the text they clicked through to
  // read. You could not read the terms you were being asked to accept.
  // Reading them is never gated; using the app still is, because every other
  // route re-renders the gate.
  const onLegalPage = location.pathname.startsWith('/legal/');
  const needsConsent = !!user && !hasAcceptedTerms(user) && !onLegalPage;
  const needsNda = !!user && !hasAcceptedNda(user) && !onLegalPage;
  const needsLegal = needsConsent || needsNda;
  // Same reasoning as the gates: nothing overlays a legal document.
  const showWelcome = !needsLegal && !onLegalPage && (forceWelcome || needsWelcome(user));

  // The platform tour is OFFERED, never auto-run. The offer now lives inside the
  // welcome dialog for brand-new accounts (one screen, not a toast stacked behind
  // it); this toast is only for users who never saw a welcome — e.g. accounts
  // created before the flow existed. `welcomeShownRef` makes sure the two can
  // never both appear in the same session.
  const [tourOffer, setTourOffer] = useState(false);
  const welcomeShownRef = useRef(false);
  if (showWelcome) welcomeShownRef.current = true;
  useEffect(() => {
    if (needsLegal || showWelcome || welcomeShownRef.current) return;
    if (hasSeen('platform') || onboardingOf(user).seenPlatformTour) return;
    if (window.location.pathname !== '/') return;
    const t = setTimeout(() => { if (!hasSeen('platform')) setTourOffer(true); }, 900);
    return () => clearTimeout(t);
  }, [showWelcome, needsLegal]); // eslint-disable-line react-hooks/exhaustive-deps
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
  //
  // NOT on a first-login session. Welcome hands off to the platform tour, and an
  // assistant panel sliding in over it gave new users two competing "start here"
  // routes at once (and a third window on an already-busy dashboard). The same
  // welcomeShownRef that keeps the tour OFFER out of a welcome session gates this
  // too. Nothing is lost by staying shut: while closed the launcher still shows
  // its "Ask Monty anything" pill, ping and badge, so the assistant stays the
  // obvious next thing to try once the tour is done.
  const autoLaunchedRef = useRef(false);
  useEffect(() => {
    if (autoLaunchedRef.current) return;
    if (!wide) return;
    if (needsLegal || showWelcome || onLegalPage) return;   // don't slide over the terms
    if (welcomeShownRef.current || tourOffer) return;       // first login: tour leads, chat waits
    if (localStorage.getItem('dm:chatAutoOpen') === '0') return;
    autoLaunchedRef.current = true;
    setChatOpen(true);
  }, [wide, needsLegal, showWelcome, onLegalPage, tourOffer]);

  // Broadcast the assistant's open/closed state. Components that share Monty's
  // bottom-right corner need to yield while the panel is up; the ones Layout
  // renders itself (ProactiveEngine, PlanPeek) take it as a prop, but
  // ProfilePrompt is page-scoped (Dashboard renders it, and it should stay
  // dashboard-only), so it subscribes to this instead of being hoisted up here.
  useEffect(() => {
    document.documentElement.dataset.chatOpen = chatOpen ? '1' : '0';
    window.dispatchEvent(new CustomEvent('dm:chat-state', { detail: { open: chatOpen } }));
  }, [chatOpen]);

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
  const [helpOpen, setHelpOpen] = useState(false);

  return (
    <>
      {/* The approved design's fixed rail. Off-canvas under `md`, where the
          hamburger + backdrop drive it. */}
      <Sidebar
        open={menuOpen}
        onNavigate={() => setMenuOpen(false)}
        onOpenChat={() => { setMenuOpen(false); setChatOpen(true); }}
      />
      {menuOpen && (
        <div className="fixed inset-0 z-[69] bg-[rgba(6,10,50,.5)] md:hidden" onClick={() => setMenuOpen(false)} aria-hidden />
      )}

      {/* On desktop the page shifts left so chat sits beside content; on mobile
          the chat is a full-screen sheet, so no shift. The rail claims 236px on
          the left from `md` up — matching .dm-sidebar's width. */}
      <div className="min-h-screen md:pl-[236px]">
        <header className="sticky top-0 z-20 border-b border-line bg-surface/90 backdrop-blur">
          <div className="mx-auto flex max-w-6xl items-center gap-3 px-4 py-3">
            <button className="md:hidden" onClick={() => setMenuOpen((o) => !o)} aria-label="Menu">
              <Menu size={22} aria-hidden />
            </button>
            {/* Nav, credits and Monty now live in the rail; the header keeps only
                what's contextual (which project) or global (alerts, account). */}
            <ProjectSelector />

            {/* Global search sits in the CENTRE of the bar, on its own. It used
                to live in the right-hand cluster wedged between the help menu and
                the avatar, which read as one more account control and got
                overlooked. Search is a global action, not a personal one — the
                right cluster stays reserved for notifications, help, theme and
                account so that grouping means something. */}
            <div className="hidden flex-1 justify-center px-4 lg:flex">
              <button
                onClick={() => window.dispatchEvent(new CustomEvent('dm:open-command'))}
                className="flex w-full max-w-md items-center gap-2 rounded-lg border border-line bg-sunken py-1.5 pl-3 pr-2 text-sm text-muted hover:border-brand-300 hover:bg-surface hover:text-dim dark:hover:border-brand-500/40"
                title="Search everything (⌘K)"
                aria-label="Open command palette"
              >
                <Search size={15} aria-hidden />
                <span className="text-[13px]">Search tools, projects and runs</span>
                <kbd className="ml-auto rounded border border-line px-1 py-0.5 text-[10px] font-semibold">⌘K</kbd>
              </button>
            </div>

            <div className="ml-auto flex shrink-0 items-center gap-2 sm:gap-3">
              <PlanWidget />
              <NotificationBell />

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

              {/* Below `lg` there's no room for the centred search bar, so it
                  collapses to this icon. */}
              <button
                onClick={() => window.dispatchEvent(new CustomEvent('dm:open-command'))}
                className="grid h-9 w-9 place-items-center rounded-lg hover:bg-sunken lg:hidden"
                title="Search (⌘K)"
                aria-label="Open command palette"
              >
                <Search size={18} className="text-dim" aria-hidden />
              </button>

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

          {/* Plan progress strip — a slim reminder of "what next" that follows
              the user off the dashboard. Self-hides on `/`, when complete, or
              after a per-session dismiss. */}
          <PlanBreadcrumb />

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

      {/* Floats over the page (mockup .monty-chat) — it no longer displaces content. */}
      <ChatDrawer open={chatOpen} onClose={() => setChatOpen(false)} ask={ask} say={say} />
      {/* Proactive Helpful Otter — desktop only (mobile chat is a full-screen sheet
          it shouldn't hijack). Suppressed until the consent/NDA/welcome overlays clear. */}
      {wide && <ProactiveEngine paused={needsLegal || showWelcome} chatOpen={chatOpen} />}
      {/* Floating launcher — desktop only, matching the assistant's own rule
          (on mobile the panel is a full-screen sheet). */}
      {wide && <MontyLauncher open={chatOpen} onOpen={() => setChatOpen(true)} onClose={() => setChatOpen(false)} />}
      {/* Once-per-session peek of the plan's next step out of the closed launcher
          — defers to the proactive nudge so the corner never double-stacks. */}
      {wide && <PlanPeek chatOpen={chatOpen} />}

      {/* ⌘K command palette — jump to any tool, page or project. */}
      <CommandPalette />

      <ExplainMenu />
      <FaultReporter />
      <Toaster />
      {/* One legal dialog. A new account needs both acceptances, so the NDA gate
          carries the Terms checkbox too (`withTerms`). The standalone consent
          gate is only for the re-consent case: an established user who already
          accepted the NDA and is being re-prompted by a TERMS_VERSION bump. */}
      {needsNda && <TrialNdaGate withTerms={needsConsent} />}
      {needsConsent && !needsNda && <ConsentGate />}
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
