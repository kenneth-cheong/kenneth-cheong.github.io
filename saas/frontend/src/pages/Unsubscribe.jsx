import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../lib/api.js';
import Logo from '../components/Logo.jsx';

// Landing page for the one-click unsubscribe link in product-update emails
// (/unsubscribe?token=…). Public — works whether or not the recipient is signed
// in. The token is opt-out-only; re-clicking simply re-applies it (idempotent).
export default function Unsubscribe() {
  const [params] = useSearchParams();
  const [status, setStatus] = useState('working'); // 'working' | 'done' | 'error'
  const [message, setMessage] = useState('Updating your email preferences…');
  const ran = useRef(false);

  useEffect(() => {
    if (ran.current) return; // guard React 18 StrictMode double-invoke
    ran.current = true;
    const token = params.get('token');
    if (!token) { setStatus('error'); setMessage('This unsubscribe link is missing its token.'); return; }
    (async () => {
      try {
        await api.unsubscribeEmail(token);
        setStatus('done');
      } catch (err) {
        setStatus('error');
        setMessage(err?.payload?.error || err?.message || 'This unsubscribe link is invalid or has expired.');
      }
    })();
  }, [params]);

  return (
    <div className="grid min-h-screen place-items-center bg-gradient-to-b from-brand-50 to-white px-4 dark:from-canvas dark:to-surface">
      <div className="card w-full max-w-md p-8 text-center">
        <Logo className="mx-auto" width={200} />
        {status === 'working' && (
          <div className="mt-6 flex items-center justify-center gap-2 text-sm text-muted">
            <span className="h-4 w-4 animate-spin rounded-full border-2 border-edge border-t-brand-600" />
            {message}
          </div>
        )}
        {status === 'done' && (
          <>
            <h1 className="mt-6 text-lg font-bold text-strong">You're unsubscribed</h1>
            <p className="mt-2 text-sm text-muted">
              You'll no longer receive product-update emails. Account emails (sign-in, billing,
              and support replies) will still be sent. You can opt back in any time from
              <span className="font-medium"> Account → Email preferences</span>.
            </p>
            <Link to="/" className="btn-primary mt-5 inline-flex">Back to Digimetrics</Link>
          </>
        )}
        {status === 'error' && (
          <>
            <p className="mt-6 text-sm text-red-600 dark:text-red-400">{message}</p>
            <Link to="/" className="btn-primary mt-5 inline-flex">Back to Digimetrics</Link>
          </>
        )}
      </div>
    </div>
  );
}
