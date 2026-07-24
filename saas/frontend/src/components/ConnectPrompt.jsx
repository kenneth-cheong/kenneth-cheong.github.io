import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Check, ShieldCheck, Clock, Coins, Plug } from 'lucide-react';
import { api } from '../lib/api.js';
import { INTEGRATIONS, FAMILY_META } from '@shared/catalog.mjs';
import Modal from './Modal.jsx';
import { toast } from '../lib/ui.js';

// "You're not connected yet" is a setup step, not a fault. Whenever an
// integration tool can't pull because the account isn't linked (or the token
// expired, or no property has been picked), we pop THIS widget — a one-click
// path to the fix — instead of a red error that pushes people into
// "Report a problem". See ToolRunner's Result / run() error handling.

// Where the OAuth round-trip should send the user back to, remembered across
// the redirect (the callback can only land on /integrations).
export const RETURN_KEY = 'dm:connect-return';

const REASONS = {
  connect: {
    title: (label) => `Connect ${label} to get started`,
    blurb: 'This tool reads your own account data — there’s nothing to show until it’s linked. It takes about 30 seconds.',
    cta: (fam) => `Continue with ${fam}`,
  },
  reconnect: {
    title: (label) => `Reconnect ${label}`,
    blurb: 'Your sign-in expired or access was revoked, so we couldn’t pull your data. Signing in again restores it — nothing else changes.',
    cta: (fam) => `Reconnect ${fam}`,
  },
  account: {
    title: (label) => `Pick the ${label} account to pull`,
    blurb: 'You’re signed in, but this tool doesn’t know which account to read yet. Choose one and run again.',
    cta: (fam) => `Change ${fam}`,
  },
};

const ASSURANCES = [
  { icon: ShieldCheck, text: 'Read-only access — we never post or change anything' },
  { icon: Coins, text: 'Pulling your own data is free — no credits are used' },
  { icon: Clock, text: 'Takes about 30 seconds, and you can disconnect anytime' },
];

const providerMeta = (provider) => INTEGRATIONS.find((p) => p.id === provider) || null;

// Not every connection failure comes back as a tidy `needsConnect` payload — an
// expired refresh token or a missing property surfaces as a thrown upstream
// error. Recognise those here so they pop this widget instead of an error card
// (and, more importantly, instead of the fault reporter).
export function connectReasonFor(message) {
  const m = String(message || '');
  if (/\bno (property|site|customer id|account|ad account)\b/i.test(m)) return 'account';
  if (/not connected|connect your|reconnect/i.test(m)) return 'connect';
  // 401/expired token → reconnect; 403/permission → the account can't read that
  // resource, so pick a different one (reconnecting won't help).
  if (/invalid_grant|token (refresh|exchange)|unauthori[sz]ed|\b401\b/i.test(m)) return 'reconnect';
  if (/permission denied|forbidden|insufficient permission|\b403\b/i.test(m)) return 'account';
  return null;
}

/**
 * @param provider  integration id ('ga4' | 'gsc' | 'google-ads' | …)
 * @param reason    'connect' (never linked) | 'reconnect' (expired/denied) | 'account' (nothing picked)
 * @param toolName  the tool the user was trying to run, for the return trip
 * @param text      server-supplied explanation, shown under the blurb when present
 * @param onReady   called after an account is picked, so the caller can re-run
 * @param popup     open as a modal on mount (default) as well as inline
 */
export default function ConnectPrompt({ provider, reason = 'connect', toolName, text, onReady, popup = true }) {
  const [open, setOpen] = useState(popup);
  const meta = providerMeta(provider);
  const label = meta?.name || 'your account';
  const fam = FAMILY_META[meta?.family || 'google'] || FAMILY_META.google;
  const famName = (fam.label || 'account').replace(/ account$/, '');
  const copy = REASONS[reason] || REASONS.connect;

  const body = (showTitle) => (
    <ConnectBody
      provider={provider} reason={reason} label={label} fam={fam} famName={famName}
      copy={copy} text={text} toolName={toolName} showTitle={showTitle}
      onReady={() => { setOpen(false); onReady?.(); }}
    />
  );

  return (
    <>
      {/* The card stays on the page behind the popup, so dismissing the popup
          still leaves the fix one click away instead of a dead result area. */}
      <div className="card mt-6 p-6">{body(true)}</div>
      <Modal open={open} onClose={() => setOpen(false)} title={copy.title(label)} labelledBy="connect-prompt-title">
        {body(false)}
      </Modal>
    </>
  );
}

function ConnectBody({ provider, reason, label, fam, famName, copy, text, toolName, showTitle, onReady }) {
  const [busy, setBusy] = useState(false);

  async function connect() {
    setBusy(true);
    try {
      // Per-source auth for a re-pick ('account'), family consent otherwise —
      // one Google sign-in covers Search Console, Analytics and Ads. Either way
      // we name the source that asked, not the family's authVia: the consent URL
      // is identical across a family, and the callback needs to know which source
      // to switch on when the rest of the family is already connected.
      const single = reason === 'account';
      const { url } = await api.authorizeIntegration(provider, { single });
      try { sessionStorage.setItem(RETURN_KEY, JSON.stringify({ provider, toolName: toolName || label })); } catch { /* private mode */ }
      window.location.href = url;
    } catch (e) {
      setBusy(false);
      toast(e.message || 'Could not start sign-in — please try again.', 'error');
    }
  }

  return (
    <div className="text-center">
      <div className="mx-auto grid h-11 w-11 place-items-center rounded-xl bg-brand-50 dark:bg-brand-500/10 text-brand-600 dark:text-brand-400">
        <Plug size={20} aria-hidden />
      </div>
      {/* Inside the popup the dialog header already carries the title. */}
      {showTitle && <p className="mt-3 text-lg font-bold text-heading">{copy.title(label)}</p>}
      <p className={`mx-auto max-w-md text-sm text-dim ${showTitle ? 'mt-1.5' : 'mt-3'}`}>{copy.blurb}</p>
      {text && <p className="mx-auto mt-1.5 max-w-md text-xs text-faint">{text}</p>}

      <ul className="mx-auto mt-4 max-w-sm space-y-2 text-left">
        {ASSURANCES.map(({ icon: Icon, text: t }) => (
          <li key={t} className="flex items-start gap-2 text-sm text-dim">
            <Icon size={15} className="mt-0.5 shrink-0 text-green-600 dark:text-green-400" aria-hidden /> {t}
          </li>
        ))}
      </ul>

      {/* Already signed in, just nothing selected → let them pick right here. */}
      {reason === 'account' && <InlineAccountPicker provider={provider} label={label} onReady={onReady} />}

      <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
        <button type="button" onClick={connect} disabled={busy} data-autofocus className="btn-primary px-4 py-2 text-sm">
          {busy ? 'Redirecting…' : copy.cta(famName)}
        </button>
        <Link to="/integrations" className="btn-ghost px-3 py-2 text-sm">Manage connections</Link>
      </div>
      <p className="mt-3 text-xs text-faint">
        Prefer to do this later? Nothing was charged — your credits are untouched.
      </p>
    </div>
  );
}

// Compact version of the Integrations page picker: the family sign-in is already
// there, so choosing the property is all that stands between them and a result.
function InlineAccountPicker({ provider, label, onReady }) {
  const [accounts, setAccounts] = useState(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let alive = true;
    api.integrationAccounts(provider)
      .then((d) => { if (alive) setAccounts(d.accounts || []); })
      .catch(() => { if (alive) setAccounts([]); });
    return () => { alive = false; };
  }, [provider]);

  async function choose(id) {
    if (!id) return;
    setSaving(true);
    try {
      await api.connectIntegration(provider, id, true);
      toast('Account selected — running again.', 'success');
      onReady?.();
    } catch (e) {
      toast(e.message || 'Could not save that account.', 'error');
    } finally { setSaving(false); }
  }

  if (accounts === null) return <p className="mt-4 text-sm text-faint">Loading your accounts…</p>;
  if (!accounts.length) return null;

  return (
    <div className="mx-auto mt-4 max-w-sm text-left">
      <label htmlFor="connect-account" className="text-xs font-medium text-muted">{label}</label>
      <select
        id="connect-account" defaultValue="" disabled={saving}
        onChange={(e) => choose(e.target.value)}
        className="dm-select mt-1 w-full rounded-lg border border-edge py-2 pl-2.5 pr-8 text-sm focus:border-brand-500 focus:outline-none"
      >
        <option value="" disabled>Select an account…</option>
        {accounts.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
      </select>
      <p className="mt-1.5 flex items-center gap-1 text-xs text-faint"><Check size={12} aria-hidden /> You can change this later under Integrations.</p>
    </div>
  );
}
