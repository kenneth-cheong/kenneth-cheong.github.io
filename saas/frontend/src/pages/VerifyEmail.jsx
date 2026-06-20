import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';

// Landing page for the email-confirmation link (/verify?token=…). Confirms the
// address, then auto-logs-in and drops the user on the dashboard.
export default function VerifyEmail() {
  const { verifyEmail } = useAuth();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [status, setStatus] = useState('working'); // 'working' | 'error'
  const [message, setMessage] = useState('Confirming your email…');
  const ran = useRef(false);

  useEffect(() => {
    if (ran.current) return; // guard React 18 StrictMode double-invoke
    ran.current = true;
    const token = params.get('token');
    if (!token) { setStatus('error'); setMessage('This confirmation link is missing its token.'); return; }
    (async () => {
      try {
        await verifyEmail(token);
        // user is now set → send them into the app.
        navigate('/', { replace: true });
      } catch (err) {
        setStatus('error');
        setMessage(err?.payload?.message || err?.message || 'This confirmation link is invalid or has expired.');
      }
    })();
  }, [params, verifyEmail, navigate]);

  return (
    <div className="grid min-h-screen place-items-center bg-gradient-to-b from-brand-50 to-white px-4">
      <div className="card w-full max-w-md p-8 text-center">
        <div className="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-brand-600 text-2xl font-bold text-white">D</div>
        {status === 'working' ? (
          <div className="mt-6 flex items-center justify-center gap-2 text-sm text-slate-500">
            <span className="h-4 w-4 animate-spin rounded-full border-2 border-slate-300 border-t-brand-600" />
            {message}
          </div>
        ) : (
          <>
            <p className="mt-6 text-sm text-red-600">{message}</p>
            <Link to="/" className="btn-primary mt-5 inline-flex">Back to sign in</Link>
          </>
        )}
      </div>
    </div>
  );
}
