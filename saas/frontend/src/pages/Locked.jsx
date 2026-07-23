import { Link } from 'react-router-dom';
import { Lock, ShieldCheck, CreditCard, LifeBuoy } from 'lucide-react';
import { useAuth } from '../context/AuthContext.jsx';
import Logo from '../components/Logo.jsx';
import ThemeToggle from '../components/ThemeToggle.jsx';

// Shown in place of the whole app when the account is locked — a free trial that
// has run out, or a subscription payment that never arrived. The server enforces
// this independently (every gated route returns 403 access_locked); this screen
// exists so the user meets an explanation and a way out instead of a wall of
// failed requests.
//
// The most important thing on the page is the reassurance that nothing was
// deleted, said plainly and above the fold. Someone who has just been locked out
// of their reporting assumes the worst, and "your data is gone" is the belief
// that turns a lapsed card into a cancelled account.
const COPY = {
  free_trial_expired: {
    icon: Lock,
    title: 'Your free trial has ended',
    lede: 'Your 7-day trial of Digimetrics is up. Choose a plan to pick up exactly where you left off.',
    cta: 'Choose a plan',
    to: '/pricing',
  },
  payment_overdue: {
    icon: CreditCard,
    title: 'Your account is on hold',
    lede: 'We weren’t able to take payment for your subscription, and the 7-day grace period has passed. Update your card to unlock your account straight away.',
    cta: 'Update payment method',
    to: '/account',
  },
};

export default function Locked() {
  const { user, logout } = useAuth();
  const reason = user?.access?.reason === 'payment_overdue' ? 'payment_overdue' : 'free_trial_expired';
  const { icon: Icon, title, lede, cta, to } = COPY[reason];

  return (
    <div className="min-h-screen bg-gradient-to-b from-brand-50 to-white dark:from-canvas dark:to-surface">
      <header className="mx-auto flex max-w-3xl items-center justify-between px-4 py-5">
        <Logo width={150} />
        <div className="flex items-center gap-2">
          <ThemeToggle />
          <button type="button" onClick={logout} className="text-sm font-medium text-muted hover:text-strong">
            Sign out
          </button>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-4 pb-16">
        <div className="rounded-2xl border border-line bg-surface p-6 shadow-sm sm:p-8">
          <span className="inline-flex h-11 w-11 items-center justify-center rounded-xl bg-brand-50 text-brand-600 dark:bg-brand-500/10 dark:text-brand-400">
            <Icon size={22} aria-hidden />
          </span>
          <h1 className="mt-4 text-2xl font-bold text-strong">{title}</h1>
          <p className="mt-2 text-sm text-muted">{lede}</p>

          <div className="mt-5 flex flex-wrap items-center gap-3">
            <Link to={to} className="btn-primary">{cta}</Link>
            <Link to="/support" className="inline-flex items-center gap-1.5 text-sm font-medium text-brand-600 dark:text-brand-400 hover:underline">
              <LifeBuoy size={15} aria-hidden />
              Talk to us
            </Link>
          </div>

          <div className="mt-7 flex items-start gap-3 rounded-xl border border-emerald-200 bg-emerald-50 p-4 dark:border-emerald-500/30 dark:bg-emerald-500/10">
            <ShieldCheck size={18} className="mt-0.5 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden />
            <div className="text-sm text-emerald-900 dark:text-emerald-200">
              <p className="font-semibold">Nothing has been deleted.</p>
              <p className="mt-1">
                Your projects, saved runs, tracked keywords, ranking history and connected
                accounts are all exactly as you left them. They come back the moment your
                {reason === 'payment_overdue' ? ' payment goes through' : ' plan starts'}.
              </p>
            </div>
          </div>

          <p className="mt-6 text-xs text-faint">
            {user?.email ? `Signed in as ${user.email}. ` : ''}Billing questions, or think this is a mistake?{' '}
            <Link to="/support" className="underline">Open a ticket</Link> — we can see your account and sort it out.
          </p>
        </div>
      </main>
    </div>
  );
}
