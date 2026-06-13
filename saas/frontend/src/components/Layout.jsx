import { useEffect, useState } from 'react';
import { Link, NavLink } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import CreditMeter from './CreditMeter.jsx';
import ChatDrawer from './ChatDrawer.jsx';
import NotificationBell from './NotificationBell.jsx';
import Toaster from './Toaster.jsx';
import ExplainMenu from './ExplainMenu.jsx';
import { useMediaQuery } from '../lib/ui.js';
import { PLANS } from '@shared/catalog.mjs';

const baseNav = [
  { to: '/', label: 'Tools', end: true },
  { to: '/integrations', label: 'Integrations' },
  { to: '/history', label: 'History' },
  { to: '/pricing', label: 'Pricing' },
  { to: '/usage', label: 'Usage' },
  { to: '/support', label: 'Support' },
  { to: '/account', label: 'Account' },
];

const CHAT_W = 384; // px — must match ChatDrawer width on desktop

export default function Layout({ children }) {
  const { user, logout } = useAuth();
  const [chatOpen, setChatOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
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

  const nav = user.isAdmin ? [...baseNav, { to: '/admin', label: 'Admin' }] : baseNav;
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
            <Link to="/" className="flex items-center gap-2 font-bold text-brand-700" onClick={() => setMenuOpen(false)}>
              <span className="grid h-7 w-7 place-items-center rounded-md bg-brand-600 text-white">D</span>
              <span className="hidden sm:inline">Digimetrics</span>
            </Link>
            <nav className="hidden gap-1 md:flex">
              {nav.map((n) => <NavLink key={n.to} to={n.to} end={n.end} className={linkCls}>{n.label}</NavLink>)}
            </nav>
            <div className="ml-auto flex items-center gap-3">
              <CreditMeter />
              <NotificationBell />
              <span className="hidden rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold uppercase tracking-wide text-slate-600 lg:inline">
                {PLANS[user.tier].name}
              </span>
              <button
                onClick={() => setChatOpen((o) => !o)}
                className={`rounded-lg px-3 py-1.5 text-sm font-semibold ${chatOpen ? 'bg-brand-600 text-white' : 'bg-slate-100 text-slate-700 hover:bg-slate-200'}`}
              >
                💬<span className="hidden sm:inline"> Assistant</span>
              </button>
              <button onClick={logout} className="hidden text-sm text-slate-500 hover:text-slate-800 sm:inline">Sign out</button>
            </div>
          </div>

          {/* Mobile menu */}
          {menuOpen && (
            <nav className="flex flex-col border-t border-slate-100 px-4 py-2 md:hidden">
              {nav.map((n) => (
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
