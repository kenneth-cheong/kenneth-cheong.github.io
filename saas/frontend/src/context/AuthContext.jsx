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

  // Store the token pair from any sign-in method and adopt the returned user.
  const adoptSession = useCallback(({ accessToken, refreshToken, user }) => {
    setToken(accessToken);
    setRefreshToken(refreshToken); // enables silent token renewal
    setUser(user);
    return user;
  }, []);

  const loginWithGoogle = useCallback(
    async (idToken) => adoptSession(await api.loginGoogle(idToken)),
    [adoptSession]
  );

  // Email/password sign-in (returns the user, or throws ApiError — callers
  // surface email_not_verified / invalid-credential messages).
  const loginWithPassword = useCallback(
    async (email, password) => adoptSession(await api.loginPassword(email, password)),
    [adoptSession]
  );

  // Sign up → backend emails a confirmation link; no session yet.
  const signup = useCallback((email, password) => api.signup(email, password), []);
  const resendVerification = useCallback((email) => api.resendVerification(email), []);
  const forgotPassword = useCallback((email) => api.forgotPassword(email), []);

  // Confirm-email and reset-password both return a fresh session → log in.
  const verifyEmail = useCallback(
    async (token) => adoptSession(await api.verifyEmail(token)),
    [adoptSession]
  );
  const resetPassword = useCallback(
    async (token, password) => adoptSession(await api.resetPassword(token, password)),
    [adoptSession]
  );

  const logout = useCallback(() => {
    setToken(null);
    setRefreshToken(null);
    setUser(null);
  }, []);

  // Let any component patch the credit balance after a tool run. Takes the total
  // spendable (`credits`) and optionally the top-up remainder so the monthly vs
  // top-up split stays exact without waiting for the next /me. Mirrors the new
  // balance to localStorage so other open tabs adopt it via the storage listener.
  const setCredits = useCallback((credits, topupCredits) => {
    setUser((u) => {
      if (!u) return u;
      const next = { ...u, credits };
      if (typeof topupCredits === 'number') next.topupCredits = topupCredits;
      return next;
    });
    try {
      localStorage.setItem('dm_credits', JSON.stringify({ credits, topupCredits, at: Date.now() }));
    } catch { /* storage unavailable — in-tab state is already updated */ }
  }, []);

  // Cross-tab credit sync: a `storage` event fires only in OTHER tabs of this
  // origin (never the writer), so adopting the broadcast here keeps every open
  // tab's meter in lockstep with no echo loop.
  useEffect(() => {
    const onStorage = (e) => {
      if (e.key !== 'dm_credits' || !e.newValue) return;
      try {
        const { credits, topupCredits } = JSON.parse(e.newValue);
        if (typeof credits !== 'number') return;
        setUser((u) => {
          if (!u) return u;
          const next = { ...u, credits };
          if (typeof topupCredits === 'number') next.topupCredits = topupCredits;
          return next;
        });
      } catch { /* ignore malformed broadcast */ }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
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

  // Free Trial + NDA acceptance. Unlike onboarding (best-effort, fire-and-forget),
  // this AWAITS the server so the gate can surface validation errors and only
  // closes on a confirmed save. The server persists the merged onboarding (with
  // acceptedNda) and emails Tom; we adopt the authoritative onboarding it returns.
  const acceptNda = useCallback(async (payload) => {
    const { onboarding } = await api.acceptNda(payload);
    setUser((u) => (u ? { ...u, onboarding: onboarding ?? u.onboarding } : u));
    return onboarding;
  }, []);

  // Save progressive-profiling answers. Optimistically merges locally, then
  // reconciles profile / completion-bonus flag / credit balance from the server
  // (authoritative). Returns the server response so callers can toast the bonus;
  // rethrows on failure so the Profile form can show an error.
  const saveProfile = useCallback(async (patch) => {
    setUser((u) => (u ? { ...u, profile: { ...(u.profile || {}), ...patch } } : u));
    const res = await api.saveProfile(patch);
    setUser((u) => (u ? {
      ...u,
      profile: res.profile ?? u.profile,
      // server pays the bonus once; never flip the flag back to false locally
      profileBonusGranted: u.profileBonusGranted || !!res.bonusGranted,
      credits: typeof res.credits === 'number' ? res.credits : u.credits,
    } : u));
    return res;
  }, []);

  return (
    <AuthCtx.Provider value={{ user, loading, loginWithGoogle, loginWithPassword, signup, resendVerification, forgotPassword, verifyEmail, resetPassword, logout, refresh, setCredits, setOnboarding, acceptNda, saveProfile }}>
      {children}
    </AuthCtx.Provider>
  );
}
