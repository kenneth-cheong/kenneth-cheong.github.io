import { describe, it, expect } from 'vitest';
import { __test } from '../src/metering/index.mjs';

const { sectionsChecker, sectionsAnchors, sectionsBacklinks, sectionsPerfMarketing, buildLlmsTxt, buildLlmsFull, extractSiteLinks } = __test;

// Every section must carry a known `type` so the frontend ResultSections
// renderer has a branch for it (heading/callout/text/stats/list/chart/cards/table).
const KNOWN = new Set(['heading', 'callout', 'text', 'stats', 'list', 'chart', 'cards', 'table']);
const assertShape = (sections) => {
  expect(Array.isArray(sections)).toBe(true);
  for (const s of sections) {
    expect(typeof s.type).toBe('string');
    expect(KNOWN.has(s.type)).toBe(true);
    if (s.type === 'stats' || s.type === 'list' || s.type === 'cards') expect(Array.isArray(s.items)).toBe(true);
    if (s.type === 'table') { expect(Array.isArray(s.columns)).toBe(true); expect(Array.isArray(s.rows)).toBe(true); }
  }
};

describe('sectionsChecker', () => {
  it('renders summary stats + issue cards with severity tones', () => {
    const summary = { flesch_score: 62, flesch_label: 'Standard', word_count: 540, total_issues: 2, by_type: { grammar: 1, tone: 1 } };
    const issues = [
      { type: 'grammar', severity: 'high', reason: 'Subject/verb', original: 'they was', suggested: 'they were' },
      { type: 'tone', severity: 'low', reason: 'Too casual' },
    ];
    const out = sectionsChecker(summary, issues);
    assertShape(out);

    const stats = out.find((s) => s.type === 'stats');
    expect(stats.items.find((i) => i.label === 'Readability').value).toContain('62');
    expect(stats.items.find((i) => i.label === 'grammar').value).toBe(1);

    const cards = out.find((s) => s.type === 'cards');
    expect(cards.items).toHaveLength(2);
    expect(cards.items[0].badgeTone).toBe('red');   // high → red
    expect(cards.items[1].badgeTone).toBe('green');  // low → green
    expect(cards.items[0].lines[0].value).toContain('they was → they were');
  });

  it('shows a clean-bill message when there are no issues', () => {
    const out = sectionsChecker(null, []);
    assertShape(out);
    expect(out.some((s) => s.type === 'text' && /No issues/.test(s.text))).toBe(true);
    expect(out.some((s) => s.type === 'cards')).toBe(false);
  });
});

describe('sectionsAnchors', () => {
  const stats = { total: 10, exact: 4, generic: 2, empty: 1, overOpt: true, health: 55 };
  const flagged = [
    { text: 'click here', href: '/a', status: 'Topically generic', priority: 'HIGH', recommendation: 'Describe the destination.' },
    { text: '', href: '/b', status: 'Empty / broken', priority: 'CRITICAL', recommendation: 'Add anchor text.' },
  ];

  it('tones low health/over-optimisation and tables the flagged anchors', () => {
    const out = sectionsAnchors('https://acme.sg', stats, flagged);
    assertShape(out);

    const stat = out.find((s) => s.type === 'stats');
    expect(stat.items.find((i) => i.label === 'Health').tone).toBe('red');     // 55 < 60
    expect(stat.items.find((i) => i.label === 'Exact-match').tone).toBe('red'); // overOpt

    expect(out.some((s) => s.type === 'callout')).toBe(true); // over-optimisation warning
    const table = out.find((s) => s.type === 'table');
    expect(table.rows).toHaveLength(2);
    expect(table.rows[0]).toMatchObject({ Anchor: 'click here', Priority: 'HIGH' });
    expect(table.rows[1].Anchor).toBe('(empty)');
  });

  it('shows a clean-bill message with no flagged anchors', () => {
    const out = sectionsAnchors('https://acme.sg', { total: 5, exact: 0, generic: 0, empty: 0, overOpt: false, health: 100 }, []);
    assertShape(out);
    expect(out.some((s) => s.type === 'callout')).toBe(false);
    expect(out.some((s) => s.type === 'table')).toBe(false);
    expect(out.some((s) => s.type === 'text' && /No problem/.test(s.text))).toBe(true);
  });
});

describe('sectionsBacklinks + sectionsPerfMarketing shape', () => {
  it('backlinks returns well-typed sections', () => {
    const out = sectionsBacklinks('acme.sg', 'overview',
      { domainAuthority: 40, totalBacklinks: 1200, refDomains: 80, dofollowPct: 65 },
      [{ domain: 'x.com', authority: 50, backlinks: 10 }],
      [{ anchor: 'acme', count: 30 }]);
    assertShape(out);
    expect(out.some((s) => s.type === 'table')).toBe(true);
  });

  it('perf-marketing returns well-typed sections', () => {
    const out = sectionsPerfMarketing({
      executive_summary: 'Strong intent, weak paid presence.',
      estimated_budget_range: { currency: 'SGD', conservative: '3,000', recommended: '5,000', aggressive: '8,000' },
      rationale: 'Bias to search for high intent.',
      platform_recommendations: [
        { platform: 'Google Search', suitability: 'high', monthly_budget: 'S$3,000', budget_share_pct: 60, primary_objective: 'Leads', rationale: 'High intent' },
      ],
      opportunities: [{ title: 'Brand defence', insight: 'Competitors bid on your brand', recommended_action: 'Bid on brand terms' }],
      quick_wins: ['Add sitelinks'],
      watch_outs: ['Watch CPC inflation'],
      sales_talking_points: ['We manage end-to-end'],
    });
    assertShape(out);
    expect(out.some((s) => s.type === 'callout' && /Strong intent/.test(s.text))).toBe(true);
    const mix = out.find((s) => s.type === 'cards' && s.title === 'Recommended channel mix');
    expect(mix.items[0]).toMatchObject({ title: 'Google Search', badgeTone: 'green', barPct: 60 });
    expect(out.some((s) => s.type === 'list' && s.tone === 'green')).toBe(true); // quick wins
  });
});

describe('llms.txt builders', () => {
  const sections = [
    { title: 'Services', links: [
      { label: 'Self Storage', url: 'https://acme.sg/storage', desc: 'Secure self-storage units' },
      { label: 'Business Storage', url: 'https://acme.sg/business', desc: 'Scalable space for inventory' },
    ] },
    { title: 'Company', links: [{ label: 'About', url: 'https://acme.sg/about', desc: '' }] },
  ];
  const opts = { title: 'Acme Storage', summary: "Singapore's storage provider.", geoPrompts: ['Where can I store my stuff in SG?'], sections };

  it('buildLlmsTxt is spec-compliant (title, blockquote, GEO prompts, sectioned links, footer)', () => {
    const txt = buildLlmsTxt(opts);
    expect(txt.startsWith('# Acme Storage')).toBe(true);
    expect(txt).toContain('> Singapore’s storage provider.'.replace('’', "'")); // summary blockquote
    expect(txt).toContain('Target Prompts for GEO:');
    expect(txt).toContain('1. Where can I store my stuff in SG?');
    expect(txt).toContain('## Services');
    expect(txt).toContain('- [Self Storage](https://acme.sg/storage): Secure self-storage units');
    expect(txt).toContain('Specification: https://llmstxt.org');
    expect(txt).not.toMatch(/\n{3,}/); // no triple blank lines
  });

  it('buildLlmsFull uses the verbose format (--- separators, ### headings, **Source**)', () => {
    const full = buildLlmsFull(opts);
    expect(full).toContain('## Services');
    expect(full).toContain('### Self Storage');
    expect(full).toContain('**Source**: https://acme.sg/storage');
    expect(full).toContain('---');
  });

  it('extractSiteLinks returns internal, absolute, deduped links and skips the homepage', () => {
    const html = `
      <a href="/about">About Us</a>
      <a href="https://www.acme.sg/services/">Services</a>
      <a href="/about">About Us</a>            <!-- dup -->
      <a href="https://other.com/x">External</a><!-- external -->
      <a href="mailto:hi@acme.sg">Email</a>     <!-- skipped -->
      <a href="https://acme.sg/">Home</a>       <!-- homepage, skipped -->`;
    const links = extractSiteLinks(html, 'acme.sg', 'https://acme.sg');
    const urls = links.map((l) => l.url);
    expect(urls).toContain('https://acme.sg/about');
    expect(urls).toContain('https://www.acme.sg/services');
    expect(urls.filter((u) => u.includes('/about'))).toHaveLength(1); // deduped
    expect(urls.some((u) => u.includes('other.com'))).toBe(false);    // external dropped
    expect(urls.some((u) => u === 'https://acme.sg')).toBe(false);    // homepage dropped
  });
});
