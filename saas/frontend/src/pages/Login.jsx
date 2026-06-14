import { useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';

export default function Login() {
  const { loginWithGoogle } = useAuth();
  const btnRef = useRef(null);

  // Render the Google Sign-In button and wire its credential to our auth.
  useEffect(() => {
    if (!window.google) return;
    window.google.accounts.id.initialize({
      client_id: import.meta.env.VITE_GOOGLE_CLIENT_ID,
      callback: (resp) => loginWithGoogle(resp.credential),
    });
    if (btnRef.current) {
      window.google.accounts.id.renderButton(btnRef.current, { theme: 'outline', size: 'large', width: 280 });
    }
  }, [loginWithGoogle]);

  return (
    <div className="grid min-h-screen place-items-center bg-gradient-to-b from-brand-50 to-white px-4">
      <div className="w-full max-w-md text-center">
        <div className="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-brand-600 text-2xl font-bold text-white">D</div>
        <h1 className="mt-6 text-3xl font-bold">Digimetrics</h1>
        <p className="mt-2 text-slate-600">SEO, AI content & AI-visibility tools for solo marketers.</p>

        <div className="card mt-8 p-6">
          <p className="mb-4 text-sm font-medium text-slate-700">Sign in to start with 30 free credits</p>
          <div className="flex justify-center" ref={btnRef} />
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
