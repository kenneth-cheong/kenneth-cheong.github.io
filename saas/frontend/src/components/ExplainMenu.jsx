import { useEffect, useRef, useState } from 'react';
import { toast } from '../lib/ui.js';

// Right-click any result/card → ask the assistant to explain it (port of the
// agency app's "Explain this in plain English" helper). Skips inputs, links,
// media, the chat panel, and selected text (leaves the native menu there).
const CARD_SEL = '.card, [data-explain], .dm-report > *, td, li';

function pickTarget(el) {
  return (el.closest && el.closest(CARD_SEL)) || el;
}

function elementText(el) {
  const c = el.cloneNode(true);
  c.querySelectorAll('button, script, style, svg, .dm-explain-menu').forEach((n) => n.remove());
  return (c.innerText || c.textContent || '').replace(/[ \t]{2,}/g, ' ').replace(/\s*\n\s*/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

// Nearest section heading ABOVE the element, without crossing into a card.
function nearestHeading(el) {
  const tagged = el.closest && el.closest('[data-section]');
  if (tagged && tagged.getAttribute('data-section')) return tagged.getAttribute('data-section').trim();
  const HEAD = 'h1,h2,h3,h4,h5,h6,.section-title';
  const labelFrom = (node) => {
    if (!node || (node.matches && node.matches('.card'))) return '';
    const h = node.matches && node.matches(HEAD) ? node : (node.querySelector ? node.querySelector(HEAD) : null);
    if (h && h.innerText && h.innerText.trim()) return h.innerText.trim().split('\n')[0].trim();
    const t = (node.innerText || '').trim();
    if (t && t.length < 90) { const first = t.split('\n')[0].trim(); if (first.length >= 2) return first; }
    return '';
  };
  let p = el, hops = 0;
  while (p && p !== document.body && hops < 6) {
    let sib = p.previousElementSibling;
    while (sib) { const l = labelFrom(sib); if (l) return l; sib = sib.previousElementSibling; }
    p = p.parentElement; hops++;
  }
  return '';
}

export default function ExplainMenu() {
  const [menu, setMenu] = useState(null); // { x, y, preview }
  const targetRef = useRef(null);
  const dataRef = useRef({ text: '', heading: '' });

  function close() {
    if (targetRef.current) { targetRef.current.classList.remove('dm-explain-hl'); targetRef.current = null; }
    setMenu(null);
  }

  useEffect(() => {
    function onCtx(e) {
      if (e.shiftKey) return; // shift+right-click → native menu
      const t = e.target;
      if (t.closest && t.closest('aside, input, textarea, select, a, img, video, [contenteditable="true"], .dm-explain-menu')) return;
      const sel = window.getSelection && window.getSelection().toString();
      if (sel && sel.trim().length) return; // leave the native copy menu for selections
      const target = pickTarget(t);
      const text = elementText(target);
      if (!text || text.length < 2) return;
      e.preventDefault();
      close();
      targetRef.current = target;
      target.classList.add('dm-explain-hl');
      dataRef.current = { text: text.length > 1500 ? text.slice(0, 1500) + '…' : text, heading: nearestHeading(target) };
      setMenu({ x: e.clientX, y: e.clientY, preview: text.slice(0, 72) });
    }
    document.addEventListener('contextmenu', onCtx, true);
    return () => document.removeEventListener('contextmenu', onCtx, true);
  }, []);

  useEffect(() => {
    if (!menu) return;
    const onDoc = (e) => { if (!e.target.closest('.dm-explain-menu')) close(); };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    document.addEventListener('mousedown', onDoc, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close, true);
    return () => {
      document.removeEventListener('mousedown', onDoc, true);
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close, true);
    };
  }, [menu]);

  // One-time discoverability hint.
  useEffect(() => {
    try {
      if (localStorage.getItem('dm_explain_hint') === '1') return;
      const t = setTimeout(() => { toast('💡 Tip: right-click any result to ask the assistant about it'); localStorage.setItem('dm_explain_hint', '1'); }, 3500);
      return () => clearTimeout(t);
    } catch { /* ignore */ }
  }, []);

  function ask(mode) {
    const { text, heading } = dataRef.current;
    close();
    const ctx = heading ? ` It appears under the section "${heading}".` : '';
    const prompt = mode === 'action'
      ? `In plain, simple English (no SEO/marketing jargon), tell me what I should actually DO about this — clear steps and how urgent it is.${ctx}\n\nHere's exactly what it says on screen:\n"${text}"`
      : `I don't fully understand this part of my Digimetrics results.${ctx} In plain, simple English (explain any term), tell me: 1) what it means, 2) why it matters for my business, 3) what to do about it.\n\nHere's exactly what it says on screen:\n"${text}"`;
    window.dispatchEvent(new CustomEvent('dm:ask', { detail: { text: prompt } }));
  }

  if (!menu) return null;
  const left = Math.max(8, Math.min(menu.x, window.innerWidth - 248));
  const top = Math.max(8, Math.min(menu.y, window.innerHeight - 116));
  return (
    <div className="dm-explain-menu fixed z-50 w-60 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-xl" style={{ left, top }}>
      <div className="truncate border-b border-slate-100 px-3 py-2 text-xs text-slate-400">{menu.preview}</div>
      <button onClick={() => ask('explain')} className="block w-full px-3 py-2 text-left text-sm hover:bg-slate-50">✨ Explain this</button>
      <button onClick={() => ask('action')} className="block w-full px-3 py-2 text-left text-sm hover:bg-slate-50">✅ What should I do about this?</button>
    </div>
  );
}
