import { useEffect, useRef, useState } from 'react';
import { Sparkles, CheckCircle2 } from 'lucide-react';
import { toast } from '../lib/ui.js';

// Right-click any result/card → ask the assistant to explain it (port of the
// agency app's "Explain this in plain English" helper). If the user has
// highlighted text, we ask about that exact selection instead of the whole
// element. Skips inputs, links, media and the chat panel; shift+right-click
// always falls back to the browser's native menu.
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

      // Highlighted text → ask about that exact selection (not the whole card).
      const selObj = window.getSelection && window.getSelection();
      const selText = (selObj ? selObj.toString() : '').replace(/[ \t]{2,}/g, ' ').trim();
      let text, heading, target = null, isSelection = false;
      if (selText && selText.length >= 2) {
        isSelection = true;
        text = selText;
        let anchorEl = selObj.anchorNode;
        if (anchorEl && anchorEl.nodeType === 3) anchorEl = anchorEl.parentElement; // text node → element
        heading = anchorEl && anchorEl.closest && !anchorEl.closest('aside, .dm-explain-menu') ? nearestHeading(anchorEl) : '';
      } else {
        target = pickTarget(t);
        text = elementText(target);
        heading = nearestHeading(target);
      }
      if (!text || text.length < 2) return;
      e.preventDefault();
      close();
      // Element pick gets the box highlight; a text selection keeps the browser's
      // native blue selection visible, so no extra class is needed.
      if (target) { targetRef.current = target; target.classList.add('dm-explain-hl'); }
      dataRef.current = { text: text.length > 1500 ? text.slice(0, 1500) + '…' : text, heading, isSelection };
      setMenu({ x: e.clientX, y: e.clientY, preview: text.slice(0, 72), isSelection });
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
      const t = setTimeout(() => { toast('Tip: right-click any result — or highlight specific text — to ask the assistant about it'); localStorage.setItem('dm_explain_hint', '1'); }, 3500);
      return () => clearTimeout(t);
    } catch { /* ignore */ }
  }, []);

  function ask(mode) {
    const { text, heading, isSelection } = dataRef.current;
    close();
    const ctx = heading ? ` It appears under the section "${heading}".` : '';
    const quoted = isSelection ? "Here's the text I highlighted:" : "Here's exactly what it says on screen:";
    const prompt = mode === 'action'
      ? `In plain, simple English (no SEO/marketing jargon), tell me what I should actually DO about this — clear steps and how urgent it is.${ctx}\n\n${quoted}\n"${text}"`
      : `I don't fully understand this part of my Digimetrics results.${ctx} In plain, simple English (explain any term), tell me: 1) what it means, 2) why it matters for my business, 3) what to do about it.\n\n${quoted}\n"${text}"`;
    window.dispatchEvent(new CustomEvent('dm:ask', { detail: { text: prompt } }));
  }

  if (!menu) return null;
  const left = Math.max(8, Math.min(menu.x, window.innerWidth - 248));
  const top = Math.max(8, Math.min(menu.y, window.innerHeight - 116));
  return (
    <div className="dm-explain-menu fixed z-50 w-60 overflow-hidden rounded-xl border border-line bg-surface shadow-xl" style={{ left, top }}>
      <div className="border-b border-hair px-3 py-2">
        {menu.isSelection && <div className="mb-0.5 text-[10px] font-semibold uppercase tracking-wide text-brand-600">Highlighted text</div>}
        <div className="truncate text-xs text-faint">{menu.preview}</div>
      </div>
      <button onClick={() => ask('explain')} className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-raised"><Sparkles size={15} className="text-brand-600" aria-hidden /> {menu.isSelection ? 'Explain the highlighted text' : 'Explain this'}</button>
      <button onClick={() => ask('action')} className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-raised"><CheckCircle2 size={15} className="text-green-600" aria-hidden /> What should I do about this?</button>
    </div>
  );
}
