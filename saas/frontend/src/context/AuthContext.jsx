import { createContext, useContext, useEffect, useRef, useState, useCallback } from 'react';
import { api, setToken, setRefreshToken } from '../lib/api.js';
import { mirrorOnboarding } from '../lib/ui.js';

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

  // api.js raises `dm:session-expired` when a request is rejected by the API's
  // authorizer and no refresh can rescue it. Dropping the user here swaps the
  // app for the login screen — without it the UI stays fully rendered while
  // every request fails, which reads as "the app is broken" rather than
  // "you're signed out".
  useEffect(() => {
    const onExpired = () => setUser(null);
    window.addEventListener('dm:session-expired', onExpired);
    return () => window.removeEventListener('dm:session-expired', onExpired);
  }, []);

  // A gated call came back `access_locked` — the trial ran out or a renewal
  // failed while this tab was open. Re-read /me (which is never gated, exactly
  // so it can answer here) and let the authoritative access state swap the app
  // for the explanation screen. Signing them out instead would be wrong twice
  // over: they'd lose the route to the payment page, and being locked is not
  // being logged out.
  useEffect(() => {
    const onLocked = () => { refresh(); };
    window.addEventListener('dm:access-locked', onLocked);
    return () => window.removeEventListener('dm:access-locked', onLocked);
  }, [refresh]);

  // Lowest balance any in-flight spend has reported. Kept in a ref (not state)
  // so several responses landing in the same tick compare against each other
  // rather than against the last committed render.
  const spentFloor = useRef(null);
  useEffect(() => { spentFloor.current = typeof user?.credits === 'number' ? user.credits : null; }, [user?.credits]);

  // Let any component patch the credit balance after a tool run. Takes the total
  // spendable (`credits`) and optionally the top-up remainder so the monthly vs
  // top-up split stays exact without waiting for the next /me. Mirrors the new
  // balance to localStorage so other open tabs adopt it via the storage listener.
  //
  // Every caller is reporting a SPEND, and a spend can never raise the balance.
  // Parallel runs — the Site Health check fires three tools at once — resolve in
  // arrival order, not charge order, so a `creditsRemaining` computed before its
  // siblings were billed can land last and undo their deductions. That is how
  // the meter was seen ticking *upward* mid-run. Holding the lowest reading
  // makes arrival order irrelevant. Genuine increases (monthly refill, top-up
  // purchase) come through refresh()/`/me`, which sets `user` directly.
  const setCredits = useCallback((credits, topupCredits) => {
    if (typeof credits !== 'number' || !Number.isFinite(credits)) return;
    if (typeof spentFloor.current === 'number' && credits > spentFloor.current) return;
    spentFloor.current = credits;
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
        // Broadcasts carry spends too, so the same floor applies — a slow
        // sibling tab must not push this tab's meter back up.
        if (typeof spentFloor.current === 'number' && credits > spentFloor.current) return;
        spentFloor.current = credits;
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
  // optimistically patch the local user so the UI updates immediately.
  //
  // The network write is best-effort and must never block the app — but a
  // swallowed failure used to mean the "welcomed"/"seenPlatformTour" flags never
  // landed, so the user was dragged back through the entire onboarding queue at
  // the next login. We now mirror every patch into localStorage first, and the
  // ui.js readers merge that mirror over the server state. A failed write costs
  // cross-device sync, not a repeat interrogation.
  //
  // Never rejects (most callers fire-and-forget), but RESOLVES to whether the
  // server actually took the patch — so the callers that care, like the legal
  // gate recording Terms acceptance, can await it and react.
  const setOnboarding = useCallback(async (patch) => {
    mirrorOnboarding(patch);
    setUser((u) => (u ? { ...u, onboarding: { ...(u.onboarding || {}), ...patch } } : u));
    try {
      const { onboarding } = await api.setOnboarding(patch);
      if (onboarding) setUser((u) => (u ? { ...u, onboarding } : u));
      return true;
    } catch {
      return false; // local patch + mirror already applied
    }
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
