import { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { api, setToken, setRefreshToken } from '../lib/api.js';

const AuthCtx = createContext(null);
export const useAuth = () => useContext(AuthCtx);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const { user } = await api.me();
      setUser(user);
    } catch {
      setUser(null);
    }
  }, []);

  // Restore session on load from the stored JWT.
  useEffect(() => {
    (async () => {
      if (localStorage.getItem('dm_access')) await refresh();
      setLoading(false);
    })();
  }, [refresh]);

  const loginWithGoogle = useCallback(async (idToken) => {
    const { accessToken, refreshToken, user } = await api.loginGoogle(idToken);
    setToken(accessToken);
    setRefreshToken(refreshToken); // enables silent token renewal
    setUser(user);
    return user;
  }, []);

  const logout = useCallback(() => {
    setToken(null);
    setRefreshToken(null);
    setUser(null);
  }, []);

  // Let any component patch the credit balance after a tool run.
  const setCredits = useCallback((credits) => {
    setUser((u) => (u ? { ...u, credits } : u));
  }, []);

  // Persist first-run onboarding state server-side (durable + cross-device) and
  // optimistically patch the local user so the UI updates immediately. Failures
  // are swallowed — onboarding is best-effort and must never block the app.
  const setOnboarding = useCallback(async (patch) => {
    setUser((u) => (u ? { ...u, onboarding: { ...(u.onboarding || {}), ...patch } } : u));
    try {
      const { onboarding } = await api.setOnboarding(patch);
      if (onboarding) setUser((u) => (u ? { ...u, onboarding } : u));
    } catch { /* best-effort; local patch already applied */ }
  }, []);

  return (
    <AuthCtx.Provider value={{ user, loading, loginWithGoogle, logout, refresh, setCredits, setOnboarding }}>
      {children}
    </AuthCtx.Provider>
  );
}
