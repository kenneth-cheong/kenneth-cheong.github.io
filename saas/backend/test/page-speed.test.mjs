import { describe, it, expect } from 'vitest';
import { __test } from '../src/metering/index.mjs';

const { sectionsPageSpeed } = __test;

const KNOWN = new Set(['heading', 'callout', 'text', 'stats', 'list', 'chart', 'cards', 'table']);
const assertShape = (sections) => {
  for (const s of sections) {
    expect(KNOWN.has(s.type)).toBe(true);
    if (s.type === 'stats') expect(Array.isArray(s.items)).toBe(true);
    if (s.type === 'cards') expect(Array.isArray(s.items)).toBe(true);
    if (s.type === 'table') { expect(Array.isArray(s.columns)).toBe(true); expect(Array.isArray(s.rows)).toBe(true); }
  }
};
const allText = (r) => JSON.stringify(r.sections);

// Shaped like a real webpageAudit response. The numbers are the ones that
// exposed the original bug: mediaonemarketing.com.sg scores 96 in the lab while
// Google rates its real-user experience SLOW, driven by a CLS of 1.00.
const MOBILE = {
  strategy: 'mobile',
  pagespeed: '96/100',
  field: {
    overall: 'SLOW', overallRating: 'poor', originFallback: false,
    metrics: {
      lcp: { label: 'Largest Contentful Paint', value: 2656, unit: 'ms', category: 'AVERAGE', rating: 'needs work' },
      cls: { label: 'Cumulative Layout Shift', value: 1.0, unit: 'score', category: 'SLOW', rating: 'poor' },
      ttfb: { label: 'Time to First Byte', value: 1633, unit: 'ms', category: 'AVERAGE', rating: 'needs work' },
    },
  },
  lab: {
    lcp: { label: 'Largest Contentful Paint', display: '2.1 s', value: 2100, score: 0.9 },
    cls: { label: 'Cumulative Layout Shift', display: '0.047', value: 0.047, score: 1 },
    tbt: { label: 'Total Blocking Time', display: '0 ms', value: 0, score: 1 },
  },
  opportunities: [
    { title: 'Reduce unused CSS', display: 'Est savings of 18 KiB', description: 'Remove dead rules.', savingsMs: 0, savingsBytes: 18432 },
    { title: 'Minify CSS', display: 'Est savings of 2 KiB', description: 'Minify.', savingsMs: 0, savingsBytes: 2048 },
  ],
};
const DESKTOP = { ...MOBILE, strategy: 'desktop', pagespeed: '100/100' };

describe('sectionsPageSpeed', () => {
  it('reports mobile and desktop as the distinct scores they now are', () => {
    const r = sectionsPageSpeed(MOBILE, DESKTOP, 'https://example.com');
    assertShape(r.sections);
    expect(r.summary).toEqual({ pageSpeedMobile: 96, pageSpeedDesktop: 100, target: 'https://example.com' });
  });

  // The bug this whole change exists to fix: a healthy lab score must not be
  // allowed to speak for a page whose real visitors are having a poor time.
  it('does not call a page fine when the field verdict is poor', () => {
    const r = sectionsPageSpeed(MOBILE, DESKTOP, 'https://example.com');
    const callout = r.sections.find((s) => s.type === 'callout');
    expect(callout.text).toContain('lab score is good');
    expect(callout.text).toContain('"poor"');
    expect(callout.text).toContain('Trust this section');
  });

  it('leads with real-visitor metrics, toned by Google’s own rating', () => {
    const r = sectionsPageSpeed(MOBILE, DESKTOP, 'https://example.com');
    const field = r.sections.filter((s) => s.type === 'stats')[1];
    expect(field.title).toBe('What real visitors experience');
    const cls = field.items.find((i) => i.label === 'Layout shift');
    expect(cls).toEqual({ label: 'Layout shift', value: '1', tone: 'red', sub: 'Good: under 0.1' });
    expect(field.items.find((i) => i.label === 'Largest Contentful Paint').value).toBe('2.7s');
  });

  // "Layout shift 1" is meaningless without the 0.1 it's meant to beat, so each
  // card carries its own good target as a subtitle.
  it('gives the good target as a subtitle on each field card', () => {
    const r = sectionsPageSpeed(MOBILE, DESKTOP, 'https://example.com');
    const field = r.sections.find((s) => s.type === 'stats' && s.title === 'What real visitors experience');
    const byLabel = Object.fromEntries(field.items.map((i) => [i.label, i.sub]));
    expect(byLabel['Layout shift']).toBe('Good: under 0.1');
    expect(byLabel['Largest Contentful Paint']).toBe('Good: under 2.5s');
    expect(byLabel['Server response']).toBe('Good: under 0.8s');
  });

  it('subtitles the score cards with their good threshold', () => {
    const r = sectionsPageSpeed(MOBILE, DESKTOP, 'https://example.com');
    const score = r.sections.find((s) => s.type === 'stats' && s.title === 'Google PageSpeed score');
    expect(score.items.every((i) => i.sub === 'Good: 90+')).toBe(true);
  });

  it('gives every lab row a good range to read the value against', () => {
    const table = sectionsPageSpeed(MOBILE, DESKTOP, 'https://example.com').sections.find((s) => s.type === 'table');
    expect(table.columns).toEqual(['Metric', 'Value', 'Good range', 'What it means']);
    const byMetric = Object.fromEntries(table.rows.map((row) => [row.Metric, row['Good range']]));
    expect(byMetric['Largest Contentful Paint']).toBe('under 2.5s');
    expect(byMetric['Cumulative Layout Shift']).toBe('under 0.1');
    expect(byMetric['Total Blocking Time']).toBe('under 200ms');
  });

  // Origin fallback means CrUX had too little data for this URL and answered
  // with the whole site. Presenting that as page-level would be a quiet lie.
  it('says so when the field data is the whole site, not this page', () => {
    const m = { ...MOBILE, field: { ...MOBILE.field, originFallback: true } };
    expect(allText(sectionsPageSpeed(m, DESKTOP, 'https://example.com'))).toContain('across your whole site');
    expect(allText(sectionsPageSpeed(MOBILE, DESKTOP, 'https://example.com'))).toContain('on this page');
  });

  it('distinguishes "no visitors yet" from a zero', () => {
    const m = { ...MOBILE, field: null };
    const d = { ...DESKTOP, field: null };
    expect(allText(sectionsPageSpeed(m, d, 'https://example.com'))).toContain('no real-visitor data for this page yet');
  });

  // Google writes descriptions in markdown; the card renders plain text, so an
  // unstripped doc link reaches the user as literal brackets.
  it('strips markdown doc links out of the fix descriptions', () => {
    const m = { ...MOBILE, opportunities: [{ title: 'Reduce unused CSS', display: 'Est savings of 18 KiB',
      description: 'Reduce unused rules. [Learn how to reduce unused CSS](https://developer.chrome.com/docs/x/).', savingsMs: 0, savingsBytes: 18432 }] };
    const body = sectionsPageSpeed(m, DESKTOP, 'https://example.com').sections.find((s) => s.type === 'cards').items[0].body;
    expect(body).not.toContain('](');
    expect(body).not.toContain('https://developer.chrome.com');
    expect(body).toContain('Learn how to reduce unused CSS.');
  });

  it('orders fixes by what they save, and costs each one', () => {
    const r = sectionsPageSpeed(MOBILE, DESKTOP, 'https://example.com');
    const cards = r.sections.find((s) => s.type === 'cards');
    expect(cards.items.map((c) => c.title)).toEqual(['Reduce unused CSS', 'Minify CSS']);
    expect(cards.items[0].meta).toBe('18KB lighter');
    expect(cards.items[0].body).toContain('Est savings of 18 KiB');
  });

  // An upstream that never sent `opportunities` has not told us the page is
  // clean — the same "absence read as good news" mistake as the lab score.
  it('stays silent about fixes when the upstream did not look', () => {
    const bare = { pagespeed: '96/100' };
    const r = sectionsPageSpeed(bare, { pagespeed: '100/100' }, 'https://example.com');
    assertShape(r.sections);
    expect(allText(r)).not.toContain('no significant loading opportunities');
  });

  it('does say the page is clean when Google looked and found nothing', () => {
    const r = sectionsPageSpeed({ ...MOBILE, opportunities: [] }, DESKTOP, 'https://example.com');
    expect(allText(r)).toContain('no significant loading opportunities');
  });

  it('survives one probe failing, and soft-fails when both do', () => {
    const one = sectionsPageSpeed(MOBILE, null, 'https://example.com');
    expect(one.summary.pageSpeedDesktop).toBeNull();
    expect(one.sections[0].items[1]).toEqual({ label: 'Desktop', value: '—', tone: 'slate', sub: 'Good: 90+' });

    const none = sectionsPageSpeed(null, null, 'https://example.com');
    expect(none._failed).toBe(true);
    expect(none.sections).toBeUndefined();
  });
});
