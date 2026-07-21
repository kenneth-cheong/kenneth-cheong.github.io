import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import ConnectPrompt from './ConnectPrompt.jsx';

// An integration tool with no connection behind it is unusable — the gateway
// refuses the run — but the form gave no sign of that: a property box, a Run
// button, and a one-line grey hint under the box. People typed an ID, ran, and
// only then met a connect prompt. This gates the tool up front instead: the
// connect widget opens over the page on arrival, and Run re-opens it rather
// than firing a request that can only come back as "connect your account".
//
// It deliberately does NOT gate on "connected but no account picked" — the
// form's own dropdown is the fix for that, and a modal over a working picker
// would be in the way.

/**
 * @param provider  the tool's integration id ('gsc' | 'ga4' | …), or falsy for
 *                  a normal tool — then the gate is permanently open.
 * @returns {{blocked: boolean, ready: boolean, reopen: () => void, key: number}}
 */
export function useIntegrationGate(provider) {
  const [connected, setConnected] = useState(null); // null = still loading
  const [configured, setConfigured] = useState(true);
  const [key, setKey] = useState(0);

  useEffect(() => {
    if (!provider) { setConnected(true); return; }
    let alive = true;
    setConnected(null);
    api.integrations()
      .then((d) => {
        if (!alive) return;
        setConnected(!!d.connected?.[provider]?.connected);
        // A connector still awaiting platform approval can't be OAuthed at all,
        // so pushing someone at a sign-in button would be a dead end — leave
        // those tools alone rather than blocking them behind a door with no key.
        const p = (d.providers || []).find((x) => x.id === provider);
        setConfigured(p ? !!p.configured : true);
      })
      // A failed lookup must not lock anyone out of a tool they can use: assume
      // connected and let the run's own connect prompt catch it.
      .catch(() => { if (alive) setConnected(true); });
    return () => { alive = false; };
  }, [provider]);

  return {
    blocked: !!provider && configured && connected === false,
    ready: connected !== null,
    reopen: () => setKey((k) => k + 1),
    key,
  };
}

// Remounting ConnectPrompt is what re-opens its modal — it takes its initial
// open state from the `popup` prop and owns it from there.
export function IntegrationGate({ gate, tool }) {
  if (!gate.blocked) return null;
  return <ConnectPrompt key={gate.key} provider={tool.integration} reason="connect" toolName={tool.name} popup />;
}
