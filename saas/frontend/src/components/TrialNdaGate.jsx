import { useState } from 'react';
import { ShieldCheck, X } from 'lucide-react';
import { NDA_VERSION } from '@shared/catalog.mjs';
import { useAuth } from '../context/AuthContext.jsx';
import NdaTermsModal from './NdaTermsModal.jsx';

// Soft-launch Free Trial + NDA gate. Shown by Layout to any signed-in trial user
// who hasn't accepted the current NDA_VERSION (after they've accepted the base
// Terms). Not dismissible — completing it is required to use the trial. The
// company form + acceptance are persisted server-side (tied to the account, so
// it's never re-asked across devices) and tom@mediaone.co is notified.
//
// `preview` mode (used by Admin → Agreements → "Preview gate") renders the exact
// same dialog but is dismissible and never submits — staff can see what trial
// users face without activating anything.
const FIELDS = [
  { key: 'name', label: 'Name', type: 'text', autoComplete: 'name' },
  { key: 'organisation', label: 'Organisation', type: 'text', autoComplete: 'organization' },
  { key: 'uen', label: 'UEN', type: 'text', placeholder: 'e.g. 201912345A' },
  { key: 'telephone', label: 'Telephone', type: 'tel', placeholder: '+65 …', autoComplete: 'tel' },
  { key: 'email', label: 'Email', type: 'email', autoComplete: 'email' },
];

const validEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test((v || '').trim());

export default function TrialNdaGate({ preview = false, onClose }) {
  const { user, acceptNda } = useAuth();
  const [form, setForm] = useState(() => ({
    name: preview ? '' : (user?.name || ''),
    organisation: '',
    uen: '',
    telephone: '',
    email: preview ? '' : (user?.email || ''),
  }));
  const [agreed, setAgreed] = useState(false);
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
      if (!form[f.key].trim()) errs[f.key] = true;
    }
    if (form.email.trim() && !validEmail(form.email)) errs.email = true;
    if (!agreed) errs.agreed = true;
    setErrors(errs);
    if (Object.keys(errs).length) {
      setServerErr('Please complete all fields and accept the terms.');
      return;
    }
    setServerErr('');
    if (preview) {
      setNotice('Preview only — in the live gate this activates the trial. Nothing was submitted.');
      return;
    }
    setBusy(true);
    try {
      await acceptNda({
        accepted: true,
        version: NDA_VERSION,
        name: form.name.trim(),
        organisation: form.organisation.trim(),
        uen: form.uen.trim(),
        telephone: form.telephone.trim(),
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
      <div className="relative my-8 w-full max-w-lg rounded-2xl border border-slate-200 bg-white p-6 shadow-2xl sm:p-8">
        {preview && (
          <button onClick={() => onClose?.()} aria-label="Close preview" className="absolute right-4 top-4 grid h-8 w-8 place-items-center rounded-lg bg-slate-100 text-slate-500 hover:bg-slate-200">
            <X size={18} />
          </button>
        )}
        <div className="flex items-center gap-2 text-brand-600">
          <span className="grid h-9 w-9 place-items-center rounded-lg bg-brand-600 text-white"><ShieldCheck size={20} aria-hidden /></span>
          <span className="text-xs font-semibold uppercase tracking-wide text-slate-400">Soft launch · Free trial</span>
          {preview && <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-amber-700">Preview</span>}
        </div>

        <h1 className="mt-4 text-xl font-bold text-slate-900">Activate your free trial</h1>
        <p className="mt-2 text-sm leading-relaxed text-slate-600">
          Please confirm your details and accept the Free Trial &amp; NDA Terms to activate
          your 180-day trial. You only need to do this once.
        </p>

        <div className="mt-5 space-y-3">
          {FIELDS.map((f) => (
            <div key={f.key}>
              <label htmlFor={`nda-${f.key}`} className="mb-1 block text-xs font-semibold text-slate-600">
                {f.label} <span className="text-rose-500">*</span>
              </label>
              <input
                id={`nda-${f.key}`}
                type={f.type}
                value={form[f.key]}
                onChange={set(f.key)}
                placeholder={f.placeholder}
                autoComplete={f.autoComplete}
                className={`w-full rounded-xl border bg-slate-50 px-3 py-2.5 text-sm text-slate-900 outline-none transition focus:border-brand-500 focus:bg-white focus:ring-2 focus:ring-brand-500/20 ${errors[f.key] ? 'border-rose-400 bg-rose-50' : 'border-slate-300'}`}
              />
            </div>
          ))}
        </div>

        <label className={`mt-5 flex cursor-pointer items-start gap-3 rounded-xl border p-3 hover:border-brand-300 ${errors.agreed ? 'border-rose-400 bg-rose-50' : 'border-slate-200'}`}>
          <input
            type="checkbox"
            checked={agreed}
            onChange={(e) => { setAgreed(e.target.checked); if (errors.agreed) setErrors((x) => ({ ...x, agreed: false })); }}
            className="mt-0.5 h-4 w-4 shrink-0 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
          />
          <span className="text-sm leading-relaxed text-slate-700">
            By clicking &lsquo;Accept and Activate Free Trial&rsquo;, I confirm that I am authorised to accept these{' '}
            <button type="button" onClick={() => setShowTerms(true)} className="font-semibold text-brand-600 underline hover:text-brand-700">
              Digimetrics Free Trial and NDA Terms
            </button>{' '}
            on behalf of myself and/or my organisation. I agree to keep Digimetrics&rsquo; non-public product
            information confidential, use the free trial only for evaluation purposes, and provide feedback where
            possible through the &lsquo;Report a problem&rsquo; feature or by emailing{' '}
            <a href="mailto:tom@mediaone.co" className="font-medium text-brand-600 hover:text-brand-700">tom@mediaone.co</a>.
          </span>
        </label>

        {serverErr && <p className="mt-3 text-sm text-rose-600">{serverErr}</p>}
        {notice && <p className="mt-3 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700">{notice}</p>}

        <button
          onClick={submit}
          disabled={busy}
          className="mt-5 w-full rounded-xl bg-brand-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? 'Activating…' : 'Accept and Activate Free Trial'}
        </button>
        <p className="mt-3 text-center text-xs text-slate-400">
          MediaOne Business Group Pte Ltd — owner/operator of Digimetrics.
        </p>
      </div>

      {showTerms && <NdaTermsModal onClose={() => setShowTerms(false)} />}
    </div>
  );
}
