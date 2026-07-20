import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import { api } from '../lib/api.js';
import ThemeToggle from '../components/ThemeToggle.jsx';

// One card, three modes: sign in (Google + email/password), create account, and
// forgot password. Email/password and Google resolve to the same account.
// Email/password can be turned off platform-wide by an admin → then only the
// Google button is shown.
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
  const [pwAuth, setPwAuth] = useState(true);   // email/password enabled?
  const [userAuth, setUserAuth] = useState(false); // username sign-in enabled?
  const [showPw, setShowPw] = useState(false);  // reveal the password field?

  // Only sign-in takes a username. Signup creates the account from an email, and
  // forgot-password needs an address to mail — so both stay email-only, and the
  // field keeps type="email" (browser validation) in those modes.
  const identMode = userAuth && mode === 'signin';

  // Ask the backend which sign-in methods are enabled. Defaults to showing the
  // password form; if admin has disabled it, we hide it and fall back to Google.
  useEffect(() => {
    let live = true;
    api.authConfig()
      .then((c) => {
        if (!live || !c) return;
        if (typeof c.passwordAuthEnabled === 'boolean') { setPwAuth(c.passwordAuthEnabled); if (!c.passwordAuthEnabled) setMode('signin'); }
        // Already the effective value — the backend ands it with passwordAuthEnabled.
        if (typeof c.usernameAuthEnabled === 'boolean') setUserAuth(c.usernameAuthEnabled);
      })
      .catch(() => { /* keep default (shown) on error */ });
    return () => { live = false; };
  }, []);

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
    setShowPw(false);
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

  const showCreditsBadge = mode !== 'forgot';

  return (
    <div className="dm-login-bg grid min-h-screen place-items-center bg-gradient-to-b from-brand-50 to-white px-4 dark:from-canvas dark:to-surface">
      {/* Colour-mode switcher, same cycler as the app shell. Fixed top-right,
          above the aurora, so signed-out visitors can pick a theme too. */}
      <div className="fixed right-4 top-4 z-20">
        <ThemeToggle />
      </div>
      <div className="relative z-10 w-full max-w-md text-center">
        <div className="dm-login-enter">
          <div className="dm-login-logo mx-auto grid h-14 w-14 place-items-center rounded-2xl text-2xl font-bold text-white">D</div>
          <h1 className="mt-6 text-3xl font-bold">Digimetrics</h1>
          {/* Tagline is the emotive hero line; the descriptor below it stays the
              plain-English "what this is". Hairlines flank it so it reads as a
              mark rather than another sentence. */}
          <div className="dm-tagline-row mt-4">
            <span className="dm-tagline-rule" aria-hidden="true" />
            <p className="dm-tagline">Prepare to do great things</p>
            <span className="dm-tagline-rule dm-tagline-rule-r" aria-hidden="true" />
          </div>
          <p className="mt-2 text-sm text-dim">SEO, AI content & AI-visibility tools for solo marketers.</p>
          {showCreditsBadge && (
            <div className="mt-3">
              <span className="dm-login-badge"><GiftIcon /> 30 free credits to start</span>
            </div>
          )}
        </div>

        {/* mt leaves room for Monty (96px) to peek over the card's top edge. */}
        <div className="card dm-login-card dm-login-enter-2 relative mt-24 p-6 text-left">
          <div className="dm-monty-peek" aria-hidden="true" />
          <p className="mb-4 text-center text-sm font-medium text-body">
            {!pwAuth
              ? 'Sign in to start with 30 free credits'
              : mode === 'signup'
                ? 'Sign up and confirm your email to claim 30 free credits'
                : mode === 'forgot'
                  ? "Enter your email and we'll send a reset link"
                  : 'Welcome back'}
          </p>

          {/* Email/password form — only when enabled platform-wide. */}
          {pwAuth && (
            busy && mode === 'signin' && password === '' ? (
              <div className="flex h-10 items-center justify-center gap-2 text-sm text-muted">
                <span className="h-4 w-4 animate-spin rounded-full border-2 border-edge border-t-brand-600" />
                Signing you in…
              </div>
            ) : (
              <form onSubmit={onSubmit} className="space-y-3">
                <label className="block">
                  <span className="mb-1 block text-xs font-medium text-dim">{identMode ? 'Email or username' : 'Email'}</span>
                  <div className="dm-field-wrap">
                    <span className="dm-field-ico" aria-hidden="true">{identMode ? <UserIcon /> : <MailIcon />}</span>
                    <input
                      // type="email" would make the browser reject a username before
                      // submit ever fires — so sign-in relaxes to text when username
                      // sign-in is on. Signup/forgot keep native email validation.
                      type={identMode ? 'text' : 'email'} required
                      autoComplete={identMode ? 'username' : 'email'} value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      placeholder={identMode ? 'you@company.com or yourname' : 'you@company.com'} className="field pl-9"
                    />
                  </div>
                </label>
                {mode !== 'forgot' && (
                  <label className="block">
                    <span className="mb-1 block text-xs font-medium text-dim">Password</span>
                    <div className="dm-field-wrap">
                      <span className="dm-field-ico" aria-hidden="true"><LockIcon /></span>
                      <input
                        type={showPw ? 'text' : 'password'} required minLength={mode === 'signup' ? 8 : undefined}
                        autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
                        value={password} onChange={(e) => setPassword(e.target.value)}
                        placeholder={mode === 'signup' ? 'At least 8 characters' : '••••••••'} className="field pl-9 pr-10"
                      />
                      <button
                        type="button" className="dm-field-toggle" onClick={() => setShowPw((v) => !v)}
                        aria-label={showPw ? 'Hide password' : 'Show password'} aria-pressed={showPw} tabIndex={-1}
                      >
                        {showPw ? <EyeOffIcon /> : <EyeIcon />}
                      </button>
                    </div>
                  </label>
                )}
                <button type="submit" disabled={busy} className="btn-primary dm-login-cta w-full">
                  {busy ? 'Please wait…' : cta}
                </button>
              </form>
            )
          )}

          {notice && <p className="mt-3 rounded-lg bg-emerald-50 dark:bg-emerald-500/10 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-300">{notice}</p>}
          {error && <p className="mt-3 text-sm text-red-600 dark:text-red-400">{error}</p>}
          {/* /auth/resend needs an address, so only offer this when they signed
              in with one — a username in the field has nothing to mail to. */}
          {unverified && (email.includes('@') ? (
            <button onClick={onResend} disabled={busy} className="mt-2 text-sm font-medium text-brand-600 dark:text-brand-400 hover:text-brand-700 dark:hover:text-brand-300">
              Resend confirmation email
            </button>
          ) : (
            <p className="mt-2 text-sm text-dim">Sign in with your email address to resend the confirmation link.</p>
          ))}

          {/* Google is always available. Show the "or" divider only when it sits
              under the password form. */}
          {mode === 'signin' && (
            <>
              {pwAuth && (
                <div className="my-4 flex items-center gap-3 text-xs text-faint">
                  <span className="h-px flex-1 bg-overlay" /> or <span className="h-px flex-1 bg-overlay" />
                </div>
              )}
              {!pwAuth && busy ? (
                <div className="flex h-10 items-center justify-center gap-2 text-sm text-muted">
                  <span className="h-4 w-4 animate-spin rounded-full border-2 border-edge border-t-brand-600" />
                  Signing you in…
                </div>
              ) : (
                <div className="flex justify-center" ref={btnRef} />
              )}
            </>
          )}

          {pwAuth && (
            <div className="mt-5 space-y-1 text-center text-sm">
              {mode === 'signin' && (
                <>
                  <p className="text-muted">
                    <button onClick={() => switchMode('forgot')} className="font-medium text-brand-600 dark:text-brand-400 hover:text-brand-700 dark:hover:text-brand-300">Forgot password?</button>
                  </p>
                  <p className="text-muted">
                    New here?{' '}
                    <button onClick={() => switchMode('signup')} className="font-medium text-brand-600 dark:text-brand-400 hover:text-brand-700 dark:hover:text-brand-300">Create an account</button>
                  </p>
                </>
              )}
              {mode !== 'signin' && (
                <p className="text-muted">
                  <button onClick={() => switchMode('signin')} className="font-medium text-brand-600 dark:text-brand-400 hover:text-brand-700 dark:hover:text-brand-300">← Back to sign in</button>
                </p>
              )}
            </div>
          )}
        </div>

        <p className="mt-4 text-xs text-faint">
          By continuing you agree to our{' '}
          <Link to="/legal/terms" className="text-brand-600 dark:text-brand-400 hover:text-brand-700 dark:hover:text-brand-300">Terms</Link> and{' '}
          <Link to="/legal/privacy" className="text-brand-600 dark:text-brand-400 hover:text-brand-700 dark:hover:text-brand-300">Privacy Notice</Link>.
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

// Small inline icons (stroke = currentColor) so they inherit the token colours
// set on their wrappers. Kept local — they're only used by this page.
const svg = { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' };
function MailIcon() { return (<svg {...svg}><rect x="2" y="4" width="20" height="16" rx="2" /><path d="m22 7-10 6L2 7" /></svg>); }
function UserIcon() { return (<svg {...svg}><path d="M20 21a8 8 0 0 0-16 0" /><circle cx="12" cy="7" r="4" /></svg>); }
function LockIcon() { return (<svg {...svg}><rect x="3" y="11" width="18" height="11" rx="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></svg>); }
function EyeIcon() { return (<svg {...svg}><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" /><circle cx="12" cy="12" r="3" /></svg>); }
function EyeOffIcon() { return (<svg {...svg}><path d="M10.7 5.1A10.9 10.9 0 0 1 12 5c6.5 0 10 7 10 7a13.2 13.2 0 0 1-2.2 3M6.6 6.6A13.3 13.3 0 0 0 2 12s3.5 7 10 7a10.9 10.9 0 0 0 4.4-.9" /><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" /><path d="m2 2 20 20" /></svg>); }
function GiftIcon() { return (<svg {...svg} width="14" height="14"><rect x="3" y="8" width="18" height="4" rx="1" /><path d="M12 8v13M20 12v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-7" /><path d="M7.5 8a2.5 2.5 0 0 1 0-5C11 3 12 8 12 8s1-5 4.5-5a2.5 2.5 0 0 1 0 5" /></svg>); }
