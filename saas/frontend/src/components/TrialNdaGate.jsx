import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ShieldCheck, X } from 'lucide-react';
import { NDA_VERSION, TERMS_VERSION } from '@shared/catalog.mjs';
import { useAuth } from '../context/AuthContext.jsx';
import NdaTermsModal from './NdaTermsModal.jsx';

// The single legal gate a new trial user passes through. Shown by Layout to any
// signed-in user who hasn't accepted the current NDA_VERSION. Not dismissible —
// completing it is required to use the trial. Acceptance is persisted
// server-side (tied to the account, so it's never re-asked across devices) and
// tom@mediaone.co is notified.
//
// `withTerms` folds the base Terms/Privacy consent INTO this dialog. It used to
// be a separate, near-identical shield-icon modal (ConsentGate) shown
// immediately before this one — so a new user faced two consecutive legal
// dialogs, then the welcome flow, then a tour prompt, then the profile nudge.
// That pile-up is the "forced through all the onboarding questions" complaint.
// The two acceptances still get their OWN checkbox (separate agreements need
// separate assent) and are recorded under their own version flags — they just
// share one screen and one submit now.
//
// `preview` mode (used by Admin → Agreements → "Preview gate") renders the exact
// same dialog but is dismissible and never submits — staff can see what trial
// users face without activating anything.
// Kept deliberately short. This used to demand Name + Organisation + UEN +
// Telephone + Email, all required — which freelancers can't satisfy (no UEN, no
// organisation) and employees inside larger companies won't chase HQ for. The
// gate is the FIRST thing a trial user sees, so every required field here is a
// signup we lose. Name + Email are prefilled from the account and are all the
// NDA actually needs to bind; Organisation is offered but optional. UEN and
// telephone moved to the profile (PROFILE_FIELDS), collected progressively later
// in the journey via ProfilePrompt.
const FIELDS = [
  { key: 'name', label: 'Name', type: 'text', autoComplete: 'name', required: true },
  { key: 'email', label: 'Email', type: 'email', autoComplete: 'email', required: true },
  { key: 'organisation', label: 'Company', type: 'text', autoComplete: 'organization',
    placeholder: 'Optional — leave blank if you’re a freelancer' },
];

const validEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test((v || '').trim());

export default function TrialNdaGate({ preview = false, withTerms = false, onClose }) {
  const { user, acceptNda, setOnboarding } = useAuth();
  const [form, setForm] = useState(() => ({
    name: preview ? '' : (user?.name || ''),
    email: preview ? '' : (user?.email || ''),
    organisation: '',
  }));
  const [agreed, setAgreed] = useState(false);
  const [agreedTerms, setAgreedTerms] = useState(false);
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);
  const [serverErr, setServerErr] = useState('');
  const [notice, setNotice] = useState('');
  const [showTerms, setShowTerms] = useState(false);

  const set = (k) => (e) => {
    setForm((f) => ({ ...f, [k]: e.target.value }));
    if (errors[k]) setErrors((x) => ({ ...x, [k]: false }));
  };

  const submit = async () => {
    if (busy) return;
    const errs = {};
    for (const f of FIELDS) {
      if (f.required && !form[f.key].trim()) errs[f.key] = true;
    }
    if (form.email.trim() && !validEmail(form.email)) errs.email = true;
    if (!agreed) errs.agreed = true;
    if (withTerms && !agreedTerms) errs.agreedTerms = true;
    setErrors(errs);
    if (Object.keys(errs).length) {
      setServerErr('Please add your name and email, and accept the terms.');
      return;
    }
    setServerErr('');
    if (preview) {
      setNotice('Preview only — in the live gate this activates the trial. Nothing was submitted.');
      return;
    }
    setBusy(true);
    try {
      // Record the base Terms consent first. It's a separate agreement with its
      // own version flag, but it rides the same submit so the user only faces
      // one screen. AWAITED, unlike the old fire-and-forget ConsentGate write:
      // when that write silently failed the flag never landed and the consent
      // dialog came back on every login.
      if (withTerms) {
        const saved = await setOnboarding({ acceptedTerms: true, acceptedTermsVersion: TERMS_VERSION });
        if (!saved) throw new Error('We couldn’t record your acceptance just now. Please check your connection and try again.');
      }
      await acceptNda({
        accepted: true,
        version: NDA_VERSION,
        name: form.name.trim(),
        organisation: form.organisation.trim(),
        email: form.email.trim(),
      });
      // On success the user's onboarding now has acceptedNda → Layout drops the gate.
    } catch (e) {
      setBusy(false);
      setServerErr(e?.message || 'Something went wrong. Please try again.');
    }
  };

  return (
    <div
      className="fixed inset-0 z-[70] flex items-start justify-center overflow-y-auto bg-slate-900/60 p-4 backdrop-blur-sm sm:items-center"
      onClick={preview ? (e) => { if (e.target === e.currentTarget) onClose?.(); } : undefined}
    >
      <div className="relative my-8 w-full max-w-lg rounded-2xl border border-line bg-surface p-6 shadow-2xl sm:p-8">
        {preview && (
          <button onClick={() => onClose?.()} aria-label="Close preview" className="absolute right-4 top-4 grid h-8 w-8 place-items-center rounded-lg bg-sunken text-muted hover:bg-overlay">
            <X size={18} />
          </button>
        )}
        <div className="flex items-center gap-2 text-brand-600 dark:text-brand-400">
          <span className="grid h-9 w-9 place-items-center rounded-lg bg-brand-600 text-white"><ShieldCheck size={20} aria-hidden /></span>
          <span className="text-xs font-semibold uppercase tracking-wide text-faint">Soft launch · Free trial</span>
          {preview && <span className="rounded-full bg-amber-100 dark:bg-amber-500/15 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-amber-700 dark:text-amber-300">Preview</span>}
        </div>

        <h1 className="mt-4 text-xl font-bold text-heading">Activate your free trial</h1>
        <p className="mt-2 text-sm leading-relaxed text-dim">
          Confirm your details and accept the Free Trial &amp; NDA Terms to activate your
          180-day trial. Two fields, once — we&rsquo;ll ask for anything else later, only if we need it.
        </p>

        <div className="mt-5 space-y-3">
          {FIELDS.map((f) => (
            <div key={f.key}>
              <label htmlFor={`nda-${f.key}`} className="mb-1 block text-xs font-semibold text-dim">
                {f.label}{' '}
                {f.required
                  ? <span className="text-rose-500" aria-hidden>*</span>
                  : <span className="font-normal text-faint">(optional)</span>}
              </label>
              <input
                id={`nda-${f.key}`}
                type={f.type}
                value={form[f.key]}
                onChange={set(f.key)}
                placeholder={f.placeholder}
                autoComplete={f.autoComplete}
                className={`w-full rounded-xl border bg-raised px-3 py-2.5 text-sm text-heading outline-none transition focus:border-brand-500 focus:bg-surface focus:ring-2 focus:ring-brand-500/20 ${errors[f.key] ? 'border-rose-400 bg-rose-50 dark:bg-rose-500/10' : 'border-edge'}`}
              />
            </div>
          ))}
        </div>

        <label className={`mt-5 flex cursor-pointer items-start gap-3 rounded-xl border p-3 hover:border-brand-300 dark:hover:border-brand-500/40 ${errors.agreed ? 'border-rose-400 bg-rose-50 dark:bg-rose-500/10' : 'border-line'}`}>
          <input
            type="checkbox"
            checked={agreed}
            onChange={(e) => { setAgreed(e.target.checked); if (errors.agreed) setErrors((x) => ({ ...x, agreed: false })); }}
            className="mt-0.5 h-4 w-4 shrink-0 rounded border-edge text-brand-600 dark:text-brand-400 focus:ring-brand-500"
          />
          <span className="text-sm leading-relaxed text-body">
            By clicking &lsquo;Accept and Activate Free Trial&rsquo;, I confirm that I am authorised to accept these{' '}
            <button type="button" onClick={() => setShowTerms(true)} className="font-semibold text-brand-600 dark:text-brand-400 underline hover:text-brand-700 dark:hover:text-brand-300">
              Digimetrics Free Trial and NDA Terms
            </button>{' '}
            on behalf of myself and/or my organisation. I agree to keep Digimetrics&rsquo; non-public product
            information confidential, use the free trial only for evaluation purposes, and provide feedback where
            possible through the &lsquo;Report a problem&rsquo; feature or by emailing{' '}
            <a href="mailto:tom@mediaone.co" className="font-medium text-brand-600 dark:text-brand-400 hover:text-brand-700 dark:hover:text-brand-300">tom@mediaone.co</a>.
          </span>
        </label>

        {/* Base Terms/Privacy consent — folded in from what used to be its own
            separate dialog. Its own checkbox, its own version flag. */}
        {withTerms && (
          <label className={`mt-3 flex cursor-pointer items-start gap-3 rounded-xl border p-3 hover:border-brand-300 dark:hover:border-brand-500/40 ${errors.agreedTerms ? 'border-rose-400 bg-rose-50 dark:bg-rose-500/10' : 'border-line'}`}>
            <input
              type="checkbox"
              checked={agreedTerms}
              onChange={(e) => { setAgreedTerms(e.target.checked); if (errors.agreedTerms) setErrors((x) => ({ ...x, agreedTerms: false })); }}
              className="mt-0.5 h-4 w-4 shrink-0 rounded border-edge text-brand-600 dark:text-brand-400 focus:ring-brand-500"
            />
            <span className="text-sm leading-relaxed text-body">
              I have read and agree to the{' '}
              <Link to="/legal/terms" target="_blank" rel="noreferrer" className="font-medium text-brand-600 dark:text-brand-400 hover:text-brand-700 dark:hover:text-brand-300">Terms and Conditions of Use</Link>{' '}
              (including the indemnity for generated recommendations) and the{' '}
              <Link to="/legal/privacy" target="_blank" rel="noreferrer" className="font-medium text-brand-600 dark:text-brand-400 hover:text-brand-700 dark:hover:text-brand-300">Privacy Notice</Link>.
              Digimetrics&rsquo; audits, scores and AI recommendations are for information only, not professional advice.
            </span>
          </label>
        )}

        {serverErr && <p className="mt-3 text-sm text-rose-600 dark:text-rose-400">{serverErr}</p>}
        {notice && <p className="mt-3 rounded-lg bg-emerald-50 dark:bg-emerald-500/10 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-300">{notice}</p>}

        <button
          onClick={submit}
          disabled={busy}
          className="mt-5 w-full rounded-xl bg-brand-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? 'Activating…' : 'Accept and Activate Free Trial'}
        </button>
        <p className="mt-3 text-center text-xs text-faint">
          MediaOne Business Group Pte Ltd — owner/operator of Digimetrics.
        </p>
      </div>

      {showTerms && <NdaTermsModal onClose={() => setShowTerms(false)} />}
    </div>
  );
}
