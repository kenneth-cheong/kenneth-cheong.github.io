import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';

// One card, three modes: sign in (Google + email/password), create account, and
// forgot password. Email/password and Google resolve to the same account.
export default function Login() {
  const { loginWithGoogle, loginWithPassword, signup, forgotPassword, resendVerification } = useAuth();
  const btnRef = useRef(null);
  const [mode, setMode] = useState('signin'); // 'signin' | 'signup' | 'forgot'
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);   // success / info message
  const [unverified, setUnverified] = useState(false); // show "resend" CTA

  // Render the Google Sign-In button and wire its credential to our auth.
  // The SDK is loaded async+defer so it may not be ready when this component
  // mounts — attach a load listener as a fallback so the button always renders.
  // Re-runs when we return to the sign-in view (the container only exists then).
  useEffect(() => {
    if (mode !== 'signin') return;
    const init = () => {
      if (!window.google || !btnRef.current) return;
      window.google.accounts.id.initialize({
        client_id: import.meta.env.VITE_GOOGLE_CLIENT_ID,
        callback: async (resp) => {
          setBusy(true);
          setError(null);
          try {
            await loginWithGoogle(resp.credential);
          } catch (err) {
            setError(authMessage(err));
            setBusy(false);
          }
        },
      });
      window.google.accounts.id.renderButton(btnRef.current, { theme: 'outline', size: 'large', width: 280 });
    };

    if (window.google) {
      init();
    } else {
      const script = document.querySelector('script[src*="accounts.google.com/gsi"]');
      script?.addEventListener('load', init);
      return () => script?.removeEventListener('load', init);
    }
  }, [loginWithGoogle, mode]);

  function switchMode(next) {
    setMode(next);
    setError(null);
    setNotice(null);
    setUnverified(false);
    setPassword('');
  }

  async function onSubmit(e) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    setUnverified(false);
    setBusy(true);
    try {
      if (mode === 'signin') {
        await loginWithPassword(email.trim(), password);
        // success → AuthProvider sets the user and the app swaps in.
      } else if (mode === 'signup') {
        const { message } = await signup(email.trim(), password);
        setNotice(message || 'Check your email to confirm your account.');
      } else {
        const { message } = await forgotPassword(email.trim());
        setNotice(message || 'If an account exists for that email, a reset link is on its way.');
      }
    } catch (err) {
      if (err?.payload?.error === 'email_not_verified') {
        setUnverified(true);
        setError(err.payload.message || 'Please confirm your email first — check your inbox.');
      } else {
        setError(authMessage(err));
      }
    } finally {
      setBusy(false);
    }
  }

  async function onResend() {
    setBusy(true);
    setError(null);
    try {
      await resendVerification(email.trim());
      setUnverified(false);
      setNotice('Confirmation email sent — check your inbox.');
    } catch (err) {
      setError(authMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const title = mode === 'signup' ? 'Create your account' : mode === 'forgot' ? 'Reset your password' : 'Sign in';
  const cta = mode === 'signup' ? 'Create account' : mode === 'forgot' ? 'Send reset link' : 'Sign in';

  return (
    <div className="grid min-h-screen place-items-center bg-gradient-to-b from-brand-50 to-white px-4">
      <div className="w-full max-w-md text-center">
        <div className="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-brand-600 text-2xl font-bold text-white">D</div>
        <h1 className="mt-6 text-3xl font-bold">Digimetrics</h1>
        <p className="mt-2 text-slate-600">SEO, AI content & AI-visibility tools for solo marketers.</p>

        <div className="card mt-8 p-6 text-left">
          <p className="mb-4 text-center text-sm font-medium text-slate-700">
            {mode === 'signup'
              ? 'Sign up and confirm your email to claim 30 free credits'
              : mode === 'forgot'
                ? "Enter your email and we'll send a reset link"
                : 'Welcome back'}
          </p>

          {busy && mode === 'signin' && password === '' ? (
            <div className="flex h-10 items-center justify-center gap-2 text-sm text-slate-500">
              <span className="h-4 w-4 animate-spin rounded-full border-2 border-slate-300 border-t-brand-600" />
              Signing you in…
            </div>
          ) : (
            <form onSubmit={onSubmit} className="space-y-3">
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-slate-600">Email</span>
                <input
                  type="email" required autoComplete="email" value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@company.com" className="field"
                />
              </label>
              {mode !== 'forgot' && (
                <label className="block">
                  <span className="mb-1 block text-xs font-medium text-slate-600">Password</span>
                  <input
                    type="password" required minLength={mode === 'signup' ? 8 : undefined}
                    autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
                    value={password} onChange={(e) => setPassword(e.target.value)}
                    placeholder={mode === 'signup' ? 'At least 8 characters' : '••••••••'} className="field"
                  />
                </label>
              )}
              <button type="submit" disabled={busy} className="btn-primary w-full">
                {busy ? 'Please wait…' : cta}
              </button>
            </form>
          )}

          {notice && <p className="mt-3 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700">{notice}</p>}
          {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
          {unverified && (
            <button onClick={onResend} disabled={busy} className="mt-2 text-sm font-medium text-brand-600 hover:text-brand-700">
              Resend confirmation email
            </button>
          )}

          {mode === 'signin' && (
            <>
              <div className="my-4 flex items-center gap-3 text-xs text-slate-400">
                <span className="h-px flex-1 bg-slate-200" /> or <span className="h-px flex-1 bg-slate-200" />
              </div>
              <div className="flex justify-center" ref={btnRef} />
            </>
          )}

          <div className="mt-5 space-y-1 text-center text-sm">
            {mode === 'signin' && (
              <>
                <p className="text-slate-500">
                  <button onClick={() => switchMode('forgot')} className="font-medium text-brand-600 hover:text-brand-700">Forgot password?</button>
                </p>
                <p className="text-slate-500">
                  New here?{' '}
                  <button onClick={() => switchMode('signup')} className="font-medium text-brand-600 hover:text-brand-700">Create an account</button>
                </p>
              </>
            )}
            {mode !== 'signin' && (
              <p className="text-slate-500">
                <button onClick={() => switchMode('signin')} className="font-medium text-brand-600 hover:text-brand-700">← Back to sign in</button>
              </p>
            )}
          </div>
        </div>

        <p className="mt-4 text-xs text-slate-400">
          By continuing you agree to our{' '}
          <Link to="/legal/terms" className="text-brand-600 hover:text-brand-700">Terms</Link> and{' '}
          <Link to="/legal/privacy" className="text-brand-600 hover:text-brand-700">Privacy Policy</Link>.
        </p>
      </div>
    </div>
  );
}

// Map a backend ApiError into a friendly sentence.
function authMessage(err) {
  const status = err?.payload?.status;
  if (status === 'paused' || status === 'inactive') {
    return `Your account has been ${status === 'paused' ? 'paused' : 'deactivated'}. Please contact support to restore access.`;
  }
  return err?.payload?.message || err?.message || 'Something went wrong. Please try again.';
}
