import { useSyncExternalStore } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import * as auditRun from '../lib/siteAuditRun.js';

// "Your health check is still running" — a header chip that follows you around
// the app while a Site Health Check is in flight.
//
// The run itself has ALWAYS survived navigation: siteAuditRun.js deliberately
// holds its state at module scope precisely so routing away doesn't throw away a
// check the user already paid for. What was missing was any way to KNOW that.
// Leave the page and every trace of the run vanishes, so the only safe-looking
// move is to sit and watch a blank three-minute wait — which is what the audit
// reported as "users must remain on the health status page".
//
// So: nothing about the run changes here. It just stops being invisible, and
// stays one click from where you left it.
export default function RunningChip() {
  const state = useSyncExternalStore(auditRun.subscribe, auditRun.getSnapshot);
  const { pathname } = useLocation();

  // On the audit page itself the step list is right there, in more detail.
  if (!state.running || pathname === '/audit') return null;

  return (
    // Shown at EVERY width. It was `hidden sm:inline-flex`, which is the reflex
    // for a header nicety — but this is the only thing telling you a paid run is
    // still alive, and being stuck watching it is worse on a small screen, not
    // better. The label collapses below `sm` instead; the spinner and the tap
    // target stay.
    <Link
      to="/audit"
      className="inline-flex items-center gap-1.5 rounded-full border border-brand-200 bg-brand-50 px-2 py-1 text-xs font-semibold text-brand-700 hover:border-brand-300 dark:border-brand-500/40 dark:bg-brand-500/10 dark:text-brand-300 sm:pr-2.5"
      title="Your Site Health Check is still running — click to watch it finish"
      aria-label="Site Health Check still running — open it"
    >
      <Loader2 size={13} className="animate-spin" aria-hidden />
      <span className="hidden sm:inline">Health check running</span>
    </Link>
  );
}
