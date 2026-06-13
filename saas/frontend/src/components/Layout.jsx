import { useEffect, useState } from 'react';
import { Link, NavLink } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import CreditMeter from './CreditMeter.jsx';
import ChatDrawer from './ChatDrawer.jsx';
import NotificationBell from './NotificationBell.jsx';
import Toaster from './Toaster.jsx';
import ExplainMenu from './ExplainMenu.jsx';
import ProjectSelector from './ProjectSelector.jsx';
import { useMediaQuery } from '../lib/ui.js';
import { PLANS } from '@shared/catalog.mjs';

// Core workflow links stay in the top bar; account/meta links live in the
// right-side account dropdown so the row never overflows.
const primaryNav = [
  { to: '/', label: 'Tools', end: true },
  { to: '/projects', label: 'Projects' },
  { to: '/tracking', label: 'Tracking' },
  { to: '/integrations', label: 'Integrations' },
  { to: '/history', label: 'History' },
];
const menuNav = [
  { to: '/account', label: 'Account' },
  { to: '/usage', label: 'Usage' },
  { to: '/pricing', label: 'Pricing' },
  { to: '/support', label: 'Support' },
];

const CHAT_W = 384; // px — must match ChatDrawer width on desktop

export default function Layout({ children }) {
  const { user, logout } = useAuth();
  const [chatOpen, setChatOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [acctOpen, setAcctOpen] = useState(false);
  const [ask, setAsk] = useState(null);
  const wide = useMediaQuery('(min-width: 768px)');

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
      <div className="min-h-screen transition-[margin] duration-200" style={{ marginRight: chatOpen && wide ? CHAT_W : 0 }}>
        <header className="sticky top-0 z-20 border-b border-slate-200 bg-white/90 backdrop-blur">
          <div className="mx-auto flex max-w-6xl items-center gap-4 px-4 py-3">
            <button className="md:hidden" onClick={() => setMenuOpen((o) => !o)} aria-label="Menu">
              <span className="text-xl">☰</span>
            </button>
            <Link to="/" className="flex shrink-0 items-center gap-2 font-bold text-brand-700" onClick={() => setMenuOpen(false)}>
              <span className="grid h-7 w-7 place-items-center rounded-md bg-brand-600 text-white">D</span>
              <span className="hidden sm:inline">Digimetrics</span>
            </Link>
            <nav className="hidden min-w-0 gap-1 md:flex">
              {primaryNav.map((n) => <NavLink key={n.to} to={n.to} end={n.end} className={linkCls}>{n.label}</NavLink>)}
            </nav>
            <div className="ml-auto flex shrink-0 items-center gap-2 sm:gap-3">
              <ProjectSelector />
              <CreditMeter />
              <NotificationBell />
              <button
                onClick={() => setChatOpen((o) => !o)}
                className={`rounded-lg px-3 py-1.5 text-sm font-semibold ${chatOpen ? 'bg-brand-600 text-white' : 'bg-slate-100 text-slate-700 hover:bg-slate-200'}`}
              >
                💬<span className="hidden lg:inline"> Assistant</span>
              </button>

              {/* Account dropdown (desktop) — holds Account/Usage/Pricing/Support/Admin + Sign out */}
              <div className="relative hidden md:block">
                <button
                  onClick={() => setAcctOpen((o) => !o)}
                  className="flex items-center gap-1.5 rounded-lg py-1 pl-1 pr-1.5 hover:bg-slate-100"
                  aria-label="Account menu"
                >
                  <span className="grid h-7 w-7 place-items-center rounded-full bg-brand-100 text-sm font-semibold text-brand-700">
                    {(user.name || user.email || '?').trim().charAt(0).toUpperCase()}
                  </span>
                  <span className="text-xs text-slate-400">▾</span>
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

          {/* Mobile menu — all links + sign out */}
          {menuOpen && (
            <nav className="flex flex-col border-t border-slate-100 px-4 py-2 md:hidden">
              {allLinks.map((n) => (
                <NavLink key={n.to} to={n.to} end={n.end} onClick={() => setMenuOpen(false)} className={linkCls}>{n.label}</NavLink>
              ))}
              <button onClick={logout} className="mt-1 px-3 py-1.5 text-left text-sm text-slate-500">Sign out</button>
            </nav>
          )}
        </header>
        <main className="mx-auto max-w-6xl px-4 py-8">{children}</main>
      </div>

      <ChatDrawer open={chatOpen} onClose={() => setChatOpen(false)} width={wide ? CHAT_W : '100%'} ask={ask} />
      <ExplainMenu />
      <Toaster />
    </>
  );
}
