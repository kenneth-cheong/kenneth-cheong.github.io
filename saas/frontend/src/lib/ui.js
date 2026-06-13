import { useEffect, useState } from 'react';

// ── Toasts ───────────────────────────────────────────────────────────────────
export function toast(msg, type = 'info') {
  window.dispatchEvent(new CustomEvent('dm:toast', { detail: { msg, type, id: Math.random().toString(36).slice(2) } }));
}

// ── Clipboard + downloads ────────────────────────────────────────────────────
export async function copyText(text) {
  try { await navigator.clipboard.writeText(text); toast('Copied to clipboard', 'success'); }
  catch { toast('Copy failed', 'error'); }
}

export function downloadCsv(rows, filename = 'export.csv') {
  if (!rows?.length) return;
  const cols = Object.keys(rows[0]);
  const esc = (v) => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
  toast('CSV downloaded', 'success');
}

// ── Misc ─────────────────────────────────────────────────────────────────────
export function useMediaQuery(query) {
  const [match, setMatch] = useState(() => (typeof window !== 'undefined' ? window.matchMedia(query).matches : true));
  useEffect(() => {
    const m = window.matchMedia(query);
    const h = (e) => setMatch(e.matches);
    m.addEventListener('change', h);
    return () => m.removeEventListener('change', h);
  }, [query]);
  return match;
}

export function fmtNum(v) {
  if (v == null || v === '') return '—';
  const n = Number(String(v).replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) && /^[\d.,-]+$/.test(String(v).trim()) ? n.toLocaleString() : v;
}

// Recently-used tools (most recent first, capped).
const RECENT_KEY = 'dm_recent_tools';
export function pushRecent(toolId) {
  try {
    const cur = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]').filter((x) => x !== toolId);
    localStorage.setItem(RECENT_KEY, JSON.stringify([toolId, ...cur].slice(0, 6)));
  } catch { /* ignore */ }
}
export function getRecent() {
  try { return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]'); } catch { return []; }
}

// Per-tool last-used inputs.
export function saveLastInput(toolId, values) {
  try { localStorage.setItem(`dm_lastinput_${toolId}`, JSON.stringify(values)); } catch { /* ignore */ }
}
export function loadLastInput(toolId) {
  try { return JSON.parse(localStorage.getItem(`dm_lastinput_${toolId}`) || 'null'); } catch { return null; }
}
