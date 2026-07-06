import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { useAuth } from './AuthContext.jsx';

// Tracks how many support tickets are awaiting a staff reply (status === 'open')
// so admins get an at-a-glance badge on the Admin menu link and the Support
// tickets tab. Polled once here (admins only) and shared, rather than each badge
// polling on its own. A ticket is "unanswered" until staff replies; once answered
// it flips to 'answered' and drops out of the count.
const SupportTicketsCtx = createContext({ unanswered: 0, refresh: () => {} });
export const useSupportTickets = () => useContext(SupportTicketsCtx);

export function SupportTicketsProvider({ children }) {
  const { user } = useAuth();
  const isAdmin = !!user?.isAdmin;
  const [unanswered, setUnanswered] = useState(0);

  const refresh = useCallback(() => {
    if (!isAdmin) { setUnanswered(0); return; }
    api.adminTickets()
      .then((d) => setUnanswered((d.tickets || []).filter((t) => t.status === 'open').length))
      .catch(() => { /* non-critical badge — leave the last known count */ });
  }, [isAdmin]);

  // Poll while an admin is signed in; clear the count for everyone else.
  useEffect(() => {
    if (!isAdmin) { setUnanswered(0); return; }
    refresh();
    const t = setInterval(refresh, 60000); // refresh once a minute
    return () => clearInterval(t);
  }, [isAdmin, refresh]);

  return (
    <SupportTicketsCtx.Provider value={{ unanswered, refresh }}>
      {children}
    </SupportTicketsCtx.Provider>
  );
}
