import { describe, it, expect } from 'vitest';
import { __test } from '../src/metering/index.mjs';

const {
  generateForensicRecommendations, faSeverityFor, faComputeHealthScore,
  faSections, faParseHomeHtml, faParseRobots, faValidTxt, faStripHtml,
} = __test;

const KNOWN = new Set(['heading', 'callout', 'text', 'stats', 'list', 'chart', 'cards', 'table']);
const assertShape = (sections) => {
  expect(Array.isArray(sections)).toBe(true);
  for (const s of sections) {
    expect(KNOWN.has(s.type)).toBe(true);
    if (s.type === 'stats') expect(Array.isArray(s.items)).toBe(true);
    if (s.type === 'cards') expect(Array.isArray(s.items)).toBe(true);
    if (s.type === 'table') { expect(Array.isArray(s.columns)).toBe(true); expect(Array.isArray(s.rows)).toBe(true); }
  }
};

// A clean site triggers no findings and scores 100.
const PERFECT = {
  ssl: 'pass', da: 60, psd: 95, psm: 92, gtmetrix: 'A', copyscape: 2,
  robots: 'Pass', custom404: 'Configured', cdn: 'Yes', uptime: 'Monitoring',
  siteliner: 4, sitemap: 'Present', https: 'Yes', metatitle: 'Home | Acme', metadesc: 'We help.',
  ga4: 'Connected', gsc: 'Connected', structdata: 'Yes', semantic: 'Yes',
  llmblock: 'No', llmstxt: 'Present', llmsfull: 'Present', spam: 3,
  rankmath: 'Installed', wordfence: 'Installed', h1: 1, h2: 5, backlinks: 1200, refdomains: 80, orgkw: 300,
  duptitles: null, dupdescs: null, unoptmeta: null, canonical: null, hreflang: null, multislash: null, sf404: null, sderrors: null,
};

describe('generateForensicRecommendations', () => {
  it('returns no findings for a clean site', () => {
    expect(generateForensicRecommendations(PERFECT)).toHaveLength(0);
  });

  it('flags broken SSL as critical, llms.txt as opportunity, slow pagespeed as warning', () => {
    const d = { ...PERFECT, ssl: 'fail', llmstxt: 'Missing', psm: 40 };
    const recs = generateForensicRecommendations(d);
    recs.forEach((r) => { r.severity = faSeverityFor(r); });
    const byKey = Object.fromEntries(recs.map((r) => [r.severity, r]));
    expect(recs.some((r) => /ssl/i.test(r.error) && r.severity === 'critical')).toBe(true);
    expect(recs.some((r) => /llms\.txt/i.test(r.error) && r.severity === 'opportunity')).toBe(true);
    expect(recs.some((r) => /mobile page speed/i.test(r.error) && r.severity === 'warning')).toBe(true);
    expect(byKey).toBeTruthy();
  });

  it('never raises Screaming-Frog findings when those fields are null', () => {
    const recs = generateForensicRecommendations(PERFECT);
    expect(recs.some((r) => /duplicate title|broken links|canonical/i.test(r.error))).toBe(false);
  });
});

describe('faComputeHealthScore', () => {
  it('is 100 for a clean site and drops with severity weight', () => {
    expect(faComputeHealthScore(PERFECT, [])).toBe(100);
    const recs = [{ severity: 'critical' }, { severity: 'warning' }, { severity: 'opportunity' }];
    // 100 - 12 - 6 - 3 = 79
    expect(faComputeHealthScore(PERFECT, recs)).toBe(79);
  });

  it('clamps to 0', () => {
    const recs = Array.from({ length: 20 }, () => ({ severity: 'critical' }));
    expect(faComputeHealthScore({ ssl: 'fail', psd: 10, psm: 10, spam: 90 }, recs)).toBe(0);
  });
});

describe('faSections', () => {
  it('renders findings as category cards (every rec) plus a GEO readiness section', () => {
    const d = { ...PERFECT, url: 'https://acme.sg', ssl: 'fail', llmstxt: 'Missing' };
    const recs = generateForensicRecommendations(d);
    recs.forEach((r) => { r.severity = faSeverityFor(r); });
    const sev = { critical: 0, warning: 0, opportunity: 0 };
    recs.forEach((r) => sev[r.severity]++);
    const sections = faSections(d, recs, faComputeHealthScore(d, recs), sev);
    assertShape(sections);
    // Every finding shows up as a card somewhere.
    const cardTitles = sections.filter((s) => s.type === 'cards').flatMap((s) => s.items.map((it) => it.title));
    recs.forEach((r) => expect(cardTitles).toContain(r.error));
    // Findings carry a severity badge.
    const findingCards = sections.filter((s) => s.type === 'cards' && /·/.test(s.title || '')).flatMap((s) => s.items);
    expect(findingCards.length).toBe(recs.length);
    expect(findingCards.every((c) => ['Critical', 'Warning', 'Opportunity'].includes(c.badge))).toBe(true);
    // Dedicated AI/GEO readiness section with a sub-score.
    expect(sections.some((s) => s.type === 'heading' && /GEO/i.test(s.text))).toBe(true);
    expect(sections.some((s) => s.type === 'stats' && s.items.some((it) => /GEO readiness/i.test(it.label)))).toBe(true);
  });

  it('shows a celebratory callout (no table) when there are no issues', () => {
    const sections = faSections({ ...PERFECT, url: 'https://acme.sg' }, [], 100, { critical: 0, warning: 0, opportunity: 0 });
    assertShape(sections);
    expect(sections.some((s) => s.type === 'table')).toBe(false);
    expect(sections.some((s) => s.type === 'callout')).toBe(true);
  });
});

describe('HTML / robots / txt heuristics', () => {
  it('detects GA4, WordPress, CDN, structured data and H1 count from homepage HTML', () => {
    const d = { h1: null, h2: null };
    const html = `<html><head><title>Acme</title>
      <script src="https://www.googletagmanager.com/gtag/js"></script>
      <script type="application/ld+json">{}</script>
      <link href="https://cdn.jsdelivr.net/x.css"></head>
      <body><header></header><nav></nav><main><h1>Hi</h1><h2>a</h2><h2>b</h2></main>
      <link href="/wp-content/themes/x/style.css"></body></html>`;
    faParseHomeHtml(html, d);
    expect(d.ga4).toBe('Connected');
    expect(d.cms).toBe('WordPress');
    expect(d.cdn).toBe('Yes');
    expect(d.structdata).toBe('Yes');
    expect(d.semantic).toBe('Yes');
    expect(d.h1).toBe(1);
    expect(d.h2).toBe(2);
  });

  it('flags GA4 not connected and structured data missing on a bare page', () => {
    const d = { h1: null, h2: null };
    faParseHomeHtml('<html><body><div>'.padEnd(300, 'x') + '</div></body></html>', d);
    expect(d.ga4).toBe('Not Connected');
    expect(d.structdata).toBe('No');
  });

  it('detects LLM-bot blocking in robots.txt', () => {
    const d = {};
    faParseRobots('User-agent: GPTBot\nDisallow: /\n\nUser-agent: *\nAllow: /', d);
    expect(d.robots).toBe('Pass');
    expect(d.llmblock).toBe('Yes');
  });

  it('treats a missing/HTML robots.txt as Missing', () => {
    const d = {};
    faParseRobots('<!doctype html><html>not found</html>', d);
    expect(d.robots).toBe('Missing');
    expect(d.llmblock).toBe('No');
  });

  it('validates real .txt bodies and rejects HTML/error pages', () => {
    expect(faValidTxt('# Acme\n> A real llms.txt file with enough content.')).toBe(true);
    expect(faValidTxt('<!DOCTYPE html><html></html>')).toBe(false);
    expect(faValidTxt('error: not found')).toBe(false);
    expect(faValidTxt('')).toBe(false);
  });

  it('strips tags/scripts to visible text', () => {
    const txt = faStripHtml('<style>x{}</style><p>Hello <b>world</b></p><script>1</script>');
    expect(txt).toBe('Hello world');
  });
});
