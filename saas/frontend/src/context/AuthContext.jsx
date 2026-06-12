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

  // Restore session on load (mock token or stored JWT).
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
    localStorage.removeItem('dm_mock');
    setUser(null);
  }, []);

  // Let any component patch the credit balance after a tool run.
  const setCredits = useCallback((credits) => {
    setUser((u) => (u ? { ...u, credits } : u));
  }, []);

  return (
    <AuthCtx.Provider value={{ user, loading, loginWithGoogle, logout, refresh, setCredits }}>
      {children}
    </AuthCtx.Provider>
  );
}
