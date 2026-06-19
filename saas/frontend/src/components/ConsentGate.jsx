import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ShieldCheck } from 'lucide-react';
import { TERMS_VERSION } from '@shared/catalog.mjs';
import { useAuth } from '../context/AuthContext.jsx';

// First-run legal consent gate. Shown by Layout to any signed-in user who hasn't
// accepted the current Terms/Privacy version (new signups, and anyone after a
// TERMS_VERSION bump). It is intentionally NOT dismissible — no skip, no
// backdrop close — because using the Service requires agreement, including the
// indemnity for Recommendations the tools generate. Acceptance is persisted
// server-side via onboarding so it sticks across devices and sessions.
export default function ConsentGate() {
  const { setOnboarding } = useAuth();
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);

  const accept = () => {
    if (!agreed || busy) return;
    setBusy(true);
    // Optimistic: setOnboarding patches local user immediately, so the gate
    // closes without waiting on the network (persists in the background).
    setOnboarding({ acceptedTerms: true, acceptedTermsVersion: TERMS_VERSION });
  };

  return (
    <div className="fixed inset-0 z-[70] flex items-start justify-center overflow-y-auto bg-slate-900/60 p-4 backdrop-blur-sm sm:items-center">
      <div className="my-8 w-full max-w-lg rounded-2xl border border-slate-200 bg-white p-6 shadow-2xl sm:p-8">
        <div className="flex items-center gap-2 text-brand-600">
          <span className="grid h-9 w-9 place-items-center rounded-lg bg-brand-600 text-white"><ShieldCheck size={20} aria-hidden /></span>
          <span className="text-sm font-semibold uppercase tracking-wide text-slate-400">Before you continue</span>
        </div>

        <h1 className="mt-4 text-xl font-bold text-slate-900">Agree to our Terms &amp; Privacy Policy</h1>
        <p className="mt-2 text-sm leading-relaxed text-slate-600">
          Digimetrics produces audits, scores, and AI-generated recommendations for
          information only — they are not professional advice. You are responsible for
          reviewing and deciding whether to act on them, and you agree to the indemnity
          covering your use of and reliance on those recommendations.
        </p>

        <label className="mt-5 flex cursor-pointer items-start gap-3 rounded-xl border border-slate-200 p-3 hover:border-brand-300">
          <input
            type="checkbox"
            checked={agreed}
            onChange={(e) => setAgreed(e.target.checked)}
            className="mt-0.5 h-4 w-4 shrink-0 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
          />
          <span className="text-sm text-slate-700">
            I have read and agree to the{' '}
            <Link to="/legal/terms" target="_blank" rel="noreferrer" className="font-medium text-brand-600 hover:text-brand-700">Terms of Service</Link>{' '}
            (including the indemnity for generated recommendations) and the{' '}
            <Link to="/legal/privacy" target="_blank" rel="noreferrer" className="font-medium text-brand-600 hover:text-brand-700">Privacy Policy</Link>.
          </span>
        </label>

        <button
          onClick={accept}
          disabled={!agreed || busy}
          className="mt-5 w-full rounded-xl bg-brand-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Agree &amp; continue
        </button>
        <p className="mt-3 text-center text-xs text-slate-400">
          You must accept to use Digimetrics. You can review these documents anytime from the footer.
        </p>
      </div>
    </div>
  );
}
