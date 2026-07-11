import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';

// Landing page for the password-reset link (/reset-password?token=…). Sets the
// new password, then auto-logs-in.
export default function ResetPassword() {
  const { resetPassword } = useAuth();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const token = params.get('token');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function onSubmit(e) {
    e.preventDefault();
    setError(null);
    if (password !== confirm) { setError('Passwords do not match.'); return; }
    if (password.length < 8) { setError('Password must be at least 8 characters.'); return; }
    setBusy(true);
    try {
      await resetPassword(token, password);
      navigate('/', { replace: true }); // logged in → into the app
    } catch (err) {
      setError(err?.payload?.message || err?.message || 'This reset link is invalid or has expired.');
      setBusy(false);
    }
  }

  return (
    <div className="grid min-h-screen place-items-center bg-gradient-to-b from-brand-50 to-white px-4 dark:from-canvas dark:to-surface">
      <div className="w-full max-w-md text-center">
        <div className="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-brand-600 text-2xl font-bold text-white">D</div>
        <h1 className="mt-6 text-2xl font-bold">Choose a new password</h1>

        <div className="card mt-8 p-6 text-left">
          {!token ? (
            <p className="text-sm text-red-600">This reset link is missing its token.</p>
          ) : (
            <form onSubmit={onSubmit} className="space-y-3">
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-dim">New password</span>
                <input
                  type="password" required minLength={8} autoComplete="new-password"
                  value={password} onChange={(e) => setPassword(e.target.value)}
                  placeholder="At least 8 characters" className="field"
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-dim">Confirm password</span>
                <input
                  type="password" required minLength={8} autoComplete="new-password"
                  value={confirm} onChange={(e) => setConfirm(e.target.value)}
                  placeholder="Re-enter your password" className="field"
                />
              </label>
              <button type="submit" disabled={busy} className="btn-primary w-full">
                {busy ? 'Saving…' : 'Set new password'}
              </button>
            </form>
          )}
          {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
          <p className="mt-5 text-center text-sm text-muted">
            <Link to="/" className="font-medium text-brand-600 hover:text-brand-700">← Back to sign in</Link>
          </p>
        </div>
      </div>
    </div>
  );
}
