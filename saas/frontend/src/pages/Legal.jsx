import { Fragment, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { TERMS_VERSION } from '@shared/catalog.mjs';
import {
  TERMS_BLOCKS, PRIVACY_BLOCKS, LEGAL_UPDATED, LEGAL_EFFECTIVE,
  PLATFORM_OWNER, LICENSEE, LEGAL_ADDRESS, LEGAL_EMAIL, LEGAL_PHONE,
} from '../lib/legalContent.js';

// Terms and Conditions of Use (Part A) + Privacy Notice (Part B), rendered from
// the executed legal instrument in lib/legalContent.js. Both are shown
// logged-out (public) and logged-in (inside the app shell).
//
// These used to be hand-written starter templates carrying a banner telling the
// reader to have a lawyer check them. They are now the real, reviewed document,
// so the banner is gone and the text is generated rather than authored here —
// nobody should be editing binding legal wording inside a JSX file.

// One text block. `x` is either a plain string or bold-aware segments.
function Text({ x }) {
  if (typeof x === 'string') return x;
  return x.map((seg, i) => (seg.b ? <strong key={i}>{seg.s}</strong> : <Fragment key={i}>{seg.s}</Fragment>));
}

const labelOf = (b) => (typeof b.x === 'string' ? b.x : b.x.map((s) => s.s).join(''));

// Slug for the in-page anchors the contents list links to. Section numbers keep
// these stable across revisions ("12. Subscription Renewal" → "s-12").
const slugOf = (label) => {
  const n = /^(\d+)\./.exec(label.trim());
  return n ? `s-${n[1]}` : null;
};

// Group consecutive `li` blocks into real lists; everything else maps 1:1.
function Blocks({ blocks }) {
  const out = [];
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (b.t === 'li') {
      const items = [];
      while (i < blocks.length && blocks[i].t === 'li') items.push(blocks[i++]);
      i--;
      out.push(
        <ul key={`u${i}`}>
          {items.map((it, j) => <li key={j}><Text x={it.x} /></li>)}
        </ul>
      );
      continue;
    }
    if (b.t === 'h1') { out.push(<h2 key={i} className="dm-legal-part"><Text x={b.x} /></h2>); continue; }
    if (b.t === 'h2') {
      out.push(<h2 key={i} id={slugOf(labelOf(b)) || undefined}><Text x={b.x} /></h2>);
      continue;
    }
    if (b.t === 'h3') { out.push(<h3 key={i}><Text x={b.x} /></h3>); continue; }
    out.push(<p key={i}><Text x={b.x} /></p>);
  }
  return out;
}

// Numbered top-level sections, linked. A 36-section instrument is unusable
// without one — the old templates were short enough not to need it.
function Contents({ blocks }) {
  const items = useMemo(
    () => blocks
      .filter((b) => b.t === 'h2')
      .map((b) => ({ label: labelOf(b), id: slugOf(labelOf(b)) }))
      .filter((x) => x.id),
    [blocks]
  );
  if (items.length < 4) return null;
  return (
    <nav aria-label="Contents" className="mt-6 rounded-xl border border-line bg-raised p-4">
      <h2 className="text-xs font-bold uppercase tracking-wide text-faint">Contents</h2>
      <ol className="mt-2 grid gap-x-6 gap-y-1 sm:grid-cols-2">
        {items.map((s) => (
          <li key={s.id}>
            <a href={`#${s.id}`} className="text-sm text-brand-600 dark:text-brand-400 hover:underline">{s.label}</a>
          </li>
        ))}
      </ol>
    </nav>
  );
}

function Shell({ title, blocks, intro, other, otherLabel }) {
  return (
    <div className="mx-auto max-w-3xl px-4 py-10">
      <Link to="/" className="text-sm text-brand-600 dark:text-brand-400 hover:text-brand-700 dark:hover:text-brand-300">← Back</Link>
      <h1 className="mt-4 text-3xl font-bold">{title}</h1>
      <p className="mt-1 text-sm text-faint">
        Last updated: {LEGAL_UPDATED} · Effective: {LEGAL_EFFECTIVE} · v{TERMS_VERSION}
      </p>

      {/* Who you are actually contracting with — Section 1 of Part A. */}
      <div className="mt-4 rounded-xl border border-line bg-raised p-4 text-sm text-dim">
        <p><span className="font-semibold text-body">Platform owner:</span> {PLATFORM_OWNER.name} (UEN {PLATFORM_OWNER.uen})</p>
        <p className="mt-1"><span className="font-semibold text-body">Authorised licensee &amp; operator:</span> {LICENSEE.name} (UEN {LICENSEE.uen})</p>
        <p className="mt-1">
          {LEGAL_ADDRESS} · <a className="text-brand-600 dark:text-brand-400" href={`mailto:${LEGAL_EMAIL}`}>{LEGAL_EMAIL}</a> · {LEGAL_PHONE}
        </p>
      </div>

      {intro}
      <Contents blocks={blocks} />

      <div className="dm-legal mt-6 max-w-none text-sm leading-relaxed text-body">
        <Blocks blocks={blocks} />
      </div>

      <p className="mt-8 text-xs text-faint">
        See also our <Link className="text-brand-600 dark:text-brand-400" to={other}>{otherLabel}</Link>.
      </p>
    </div>
  );
}

export function Terms() {
  return (
    <Shell
      title="Terms and Conditions of Use"
      blocks={TERMS_BLOCKS}
      other="/legal/privacy"
      otherLabel="Privacy Notice"
      intro={
        <p className="mt-4 text-sm leading-relaxed text-dim">
          These Terms govern access to and use of the Digimetrics.ai website, software platform,
          applications, artificial intelligence features, reports, dashboards, integrations, APIs and
          related services. By creating or using an Account, starting a trial, purchasing a
          subscription or continuing to use Digimetrics.ai, you agree to be legally bound by them.
        </p>
      }
    />
  );
}

export function Privacy() {
  return (
    <Shell
      title="Privacy Notice"
      blocks={PRIVACY_BLOCKS}
      other="/legal/terms"
      otherLabel="Terms and Conditions of Use"
      intro={
        <p className="mt-4 text-sm leading-relaxed text-dim">
          This Notice explains what personal data we collect, how we use and share it, and the rights
          available to you under the Singapore Personal Data Protection Act and, where applicable, the
          GDPR. To export or delete your data, use{' '}
          <Link className="text-brand-600 dark:text-brand-400" to="/account">Account → Your data</Link>.
        </p>
      }
    />
  );
}
