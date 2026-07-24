import { describe, it, expect, afterEach } from 'vitest';
import { __test } from '../src/metering/index.mjs';
import { UPSTREAMS } from '../src/metering/upstreams.mjs';

const { competitorsRun, competitorsCompare } = __test;

// Fixtures below are trimmed copies of REAL upstream responses (curl'd against
// serpCompetitors and domainIntersection on 2026-07-24), not hand-written
// guesses — including the detail that bites: DataForSEO spells one side of a
// comparison `www.impossible.sg` and the other `digimetrics.ai`, so
// anything matching domains by string equality silently finds nothing.
const SERP = {
  statusCode: 200,
  body: {
    'www.firstpagedigital.sg': { 'digital marketing agency': 1 },
    'www.impossible.sg': { 'digital marketing agency': 17 },
    'digimetrics.ai': { 'digital marketing agency': 38 },
    'clutch.co': { 'digital marketing agency': 16 },
  },
};

const INTERSECTION = {
  'digital marketing advertising agency': {
    search_volume: 4400, cpc: 43.84000015258789, competition_level: 'LOW',
    'digimetrics.ai': [43, 'https://digimetrics.ai/'],
    'www.impossible.sg': [16, 'https://www.impossible.sg/best-digital-marketing-agencies-in-singapore/'],
  },
  'agency for digital marketing': {
    search_volume: 4400, cpc: 43.84000015258789, competition_level: 'LOW',
    'digimetrics.ai': [34, 'https://digimetrics.ai/'],
    'www.impossible.sg': [6, 'https://www.impossible.sg/'],
  },
  'seo agency singapore': {
    search_volume: 1300, cpc: 12.5, competition_level: 'MEDIUM',
    'digimetrics.ai': [3, 'https://digimetrics.ai/seo/'],
    'www.impossible.sg': [24, 'https://www.impossible.sg/'],
  },
};

const json = (o) => ({ ok: true, status: 200, text: async () => JSON.stringify(o) });
const realFetch = global.fetch;
afterEach(() => { global.fetch = realFetch; });

/** Mock every upstream this tool touches; `hits` records what was asked for. */
function mockUpstreams({ intersection = INTERSECTION, fail = [] } = {}) {
  const hits = [];
  global.fetch = async (url, opts) => {
    const b = JSON.parse(opts.body);
    hits.push({ url, body: b });
    if (url === UPSTREAMS.serpCompetitors) return json(SERP);
    if (url === UPSTREAMS.domainIntersection) {
      if (fail.includes(b.target2)) return { ok: false, status: 502, text: async () => 'bad gateway' };
      return json(intersection);
    }
    return json({ result: '[]' }); // insights / recommendations → empty, best-effort
  };
  return hits;
}

const table = (s) => s.find((x) => x.type === 'table');
const stat = (s, label) => s.find((x) => x.type === 'stats')?.items.find((i) => i.label === label)?.value;

describe('competitors — step 1 (discovery)', () => {
  it('marks the user\'s own domain, counts their rankings, and offers the rivals for step 2', async () => {
    mockUpstreams();
    const { sections } = await competitorsRun({
      input: 'digital marketing agency', domain: 'https://www.digimetrics.ai/seo/', location: 'Singapore',
    });

    // The user is not a competitor of themselves.
    expect(stat(sections, 'Competitors found')).toBe(3);
    expect(stat(sections, 'Keywords you rank for')).toBe('1 of 1');
    expect(stat(sections, 'Your best position')).toBe('#38');

    const rows = table(sections).rows;
    expect(rows.find((r) => /digimetrics/.test(r.Competitor)).Competitor).toMatch(/\(you\)$/);

    const picker = sections.find((s) => s.type === 'select');
    expect(picker.name).toBe('compareWith');
    expect(picker.max).toBe(3);
    // Bare domains, own domain excluded — these go straight back as `compareWith`.
    expect(picker.options.map((o) => o.value)).toEqual(['firstpagedigital.sg', 'impossible.sg', 'clutch.co']);
    expect(picker.action.requires).toBe('domain');
  });

  it('says out loud when the user ranks for none of the keywords', async () => {
    mockUpstreams();
    const { sections } = await competitorsRun({ input: 'digital marketing agency', domain: 'nowhere.example' });
    expect(stat(sections, 'Keywords you rank for')).toBe('0 of 1');
    expect(sections.find((s) => s.type === 'callout').text).toMatch(/doesn’t rank in the top results/);
  });

  it('still runs without a domain — discovery alone is a valid answer', async () => {
    mockUpstreams();
    const { sections } = await competitorsRun({ input: 'digital marketing agency' });
    expect(stat(sections, 'Competitors found')).toBe(4);   // nobody is "you"
    expect(stat(sections, 'Keywords you rank for')).toBeUndefined();
    expect(sections.some((s) => s.type === 'callout')).toBe(false);
  });
});

describe('competitors — step 2 (head-to-head compare)', () => {
  it('matches domains across the www. mismatch and scores each gap', async () => {
    mockUpstreams();
    const { sections } = await competitorsRun({
      input: 'digital marketing agency', domain: 'digimetrics.ai',
      compareWith: ['impossible.sg'], location: 'Singapore',
    });

    expect(stat(sections, 'Shared keywords')).toBe(3);
    expect(stat(sections, 'You rank ahead')).toBe(1);      // #3 vs #24
    expect(stat(sections, 'They rank ahead')).toBe(2);
    expect(stat(sections, 'Winnable (they’re top 10, you’re not)')).toBe(1); // they're #6, we're #34

    const t = table(sections);
    expect(t.columns).toEqual(['Keyword', 'Volume/mo', 'CPC', 'You', 'impossible.sg', 'Gap']);
    // Biggest volume-weighted gap first.
    expect(t.rows[0].Keyword).toBe('agency for digital marketing');
    expect(t.rows[0]).toMatchObject({ You: '#34', 'impossible.sg': '#6', Gap: '−28 behind', 'Volume/mo': 4400, CPC: '$43.84' });
    expect(t.rows.find((r) => r.Keyword === 'seo agency singapore').Gap).toBe('+21 ahead');
  });

  it('refuses to compare without a "you", and never compares a domain to itself', async () => {
    mockUpstreams();
    await expect(competitorsCompare({ compareWith: ['a.com'] }, ['a.com'])).rejects.toThrow(/Add your domain first/);
    // Ticking yourself falls through to discovery rather than running an empty compare.
    const { sections } = await competitorsRun({ input: 'x', domain: 'digimetrics.ai', compareWith: ['www.digimetrics.ai'] });
    expect(sections.some((s) => s.type === 'select')).toBe(true);
  });

  it('reports the rivals it couldn\'t reach instead of dropping them silently', async () => {
    mockUpstreams({ fail: ['clutch.co'] });
    const { sections } = await competitorsRun({
      domain: 'digimetrics.ai', compareWith: ['impossible.sg', 'clutch.co'],
    });
    expect(sections.find((s) => s.type === 'callout').text).toMatch(/couldn’t reach the data for clutch\.co/);
    expect(table(sections).columns).toContain('clutch.co');
  });

  it('explains an empty intersection rather than rendering a blank table', async () => {
    mockUpstreams({ intersection: {} });
    const { sections } = await competitorsRun({ domain: 'digimetrics.ai', compareWith: ['impossible.sg'] });
    expect(sections).toHaveLength(1);
    expect(sections[0].text).toMatch(/don’t share any ranking keywords/);
  });

  it('caps how many rivals one run fans out to', async () => {
    const hits = mockUpstreams();
    await competitorsRun({ domain: 'me.com', compareWith: ['a.com', 'b.com', 'c.com', 'd.com', 'e.com'] });
    const compared = hits.filter((h) => h.url === UPSTREAMS.domainIntersection).map((h) => h.body.target2);
    expect(compared).toEqual(['a.com', 'b.com', 'c.com']);
  });
});
