import { useState } from 'react';
import { Link, NavLink } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import CreditMeter from './CreditMeter.jsx';
import ChatDrawer from './ChatDrawer.jsx';
import NotificationBell from './NotificationBell.jsx';
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

const CHAT_W = 384; // px — keep in sync with ChatDrawer width (w-96)

export default function Layout({ children }) {
  const { user, logout } = useAuth();
  const [chatOpen, setChatOpen] = useState(false);
  const nav = user.isAdmin ? [...baseNav, { to: '/admin', label: 'Admin' }] : baseNav;
  return (
    <>
      {/* The page shifts left when the assistant is open, so chat sits beside
          the content (like the agency app) instead of covering it. */}
      <div className="min-h-screen transition-[margin] duration-200" style={{ marginRight: chatOpen ? CHAT_W : 0 }}>
        <header className="sticky top-0 z-20 border-b border-slate-200 bg-white/90 backdrop-blur">
          <div className="mx-auto flex max-w-6xl items-center gap-6 px-4 py-3">
            <Link to="/" className="flex items-center gap-2 font-bold text-brand-700">
              <span className="grid h-7 w-7 place-items-center rounded-md bg-brand-600 text-white">D</span>
              Digimetrics
            </Link>
            <nav className="hidden gap-1 md:flex">
              {nav.map((n) => (
                <NavLink
                  key={n.to}
                  to={n.to}
                  end={n.end}
                  className={({ isActive }) =>
                    `rounded-lg px-3 py-1.5 text-sm font-medium ${
                      isActive ? 'bg-brand-50 text-brand-700' : 'text-slate-600 hover:bg-slate-100'
                    }`
                  }
                >
                  {n.label}
                </NavLink>
              ))}
            </nav>
            <div className="ml-auto flex items-center gap-4">
              <CreditMeter />
              <NotificationBell />
              <span className="hidden rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold uppercase tracking-wide text-slate-600 sm:inline">
                {PLANS[user.tier].name}
              </span>
              <button
                onClick={() => setChatOpen((o) => !o)}
                className={`rounded-lg px-3 py-1.5 text-sm font-semibold ${chatOpen ? 'bg-brand-600 text-white' : 'bg-slate-100 text-slate-700 hover:bg-slate-200'}`}
              >
                💬 Assistant
              </button>
              <button onClick={logout} className="text-sm text-slate-500 hover:text-slate-800">
                Sign out
              </button>
            </div>
          </div>
        </header>
        <main className="mx-auto max-w-6xl px-4 py-8">{children}</main>
      </div>

      <ChatDrawer open={chatOpen} onClose={() => setChatOpen(false)} width={CHAT_W} />
    </>
  );
}
