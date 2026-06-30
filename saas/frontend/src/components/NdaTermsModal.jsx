import { X } from 'lucide-react';
import { NDA_VERSION } from '@shared/catalog.mjs';
import { AGREEMENT_TITLE, AGREEMENT_INTRO, AGREEMENT_SECTIONS } from '@shared/agreement.mjs';

// The full Free Trial + NDA terms, rendered from the shared @shared/agreement.mjs
// source. Shown to trial users from the activation gate AND to staff (Admin →
// Agreements → "Preview NDA") so everyone sees the exact same wording the
// Acceptance Record PDF embeds. Pass showVersion to surface the version number
// (handy for staff; the user-facing gate keeps it off to match what users read).
export default function NdaTermsModal({ onClose, showVersion = false }) {
  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-slate-900/60 p-4 backdrop-blur-sm" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="flex max-h-[88vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl">
        <div className="flex items-center justify-between gap-3 border-b border-slate-200 px-6 py-4">
          <div>
            <h2 className="text-base font-bold text-slate-900">{AGREEMENT_TITLE}</h2>
            {showVersion && <p className="mt-0.5 text-xs text-slate-400">Version {NDA_VERSION} · exactly what trial users see and what the Acceptance Record PDF embeds</p>}
          </div>
          <button onClick={onClose} aria-label="Close" className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-slate-100 text-slate-500 hover:bg-slate-200"><X size={18} /></button>
        </div>
        <div className="space-y-3 overflow-y-auto px-6 py-5 text-sm leading-relaxed text-slate-700">
          {AGREEMENT_INTRO.map((intro, i) => (
            <p key={i} className={intro.boxed ? 'rounded-lg border border-slate-200 bg-slate-50 p-3' : undefined}>
              {intro.text}
            </p>
          ))}

          {AGREEMENT_SECTIONS.map((sec) => (
            <Section key={sec.n} n={sec.n} title={sec.title}>
              {sec.blocks.map((block, i) => (
                block.list
                  ? <List key={i} items={block.list} />
                  : <p key={i}>{block.p}</p>
              ))}
            </Section>
          ))}
        </div>
        <div className="border-t border-slate-200 px-6 py-3 text-right">
          <button onClick={onClose} className="rounded-xl bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700">Close</button>
        </div>
      </div>
    </div>
  );
}

function Section({ n, title, children }) {
  return (
    <div>
      <h3 className="mt-4 text-sm font-bold text-brand-700">{n}. {title}</h3>
      <div className="space-y-2">{children}</div>
    </div>
  );
}

function List({ items }) {
  return (
    <ol className="ml-5 list-[lower-alpha] space-y-1">
      {items.map((t, i) => <li key={i}>{t}</li>)}
    </ol>
  );
}
