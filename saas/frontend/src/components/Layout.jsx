import { Link, NavLink } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import CreditMeter from './CreditMeter.jsx';
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

export default function Layout({ children }) {
  const { user, logout } = useAuth();
  const nav = user.isAdmin ? [...baseNav, { to: '/admin', label: 'Admin' }] : baseNav;
  return (
    <div className="min-h-screen">
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
            <span className="hidden rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold uppercase tracking-wide text-slate-600 sm:inline">
              {PLANS[user.tier].name}
            </span>
            <button onClick={logout} className="text-sm text-slate-500 hover:text-slate-800">
              Sign out
            </button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-8">{children}</main>
    </div>
  );
}
