import { describe, it, expect, afterEach } from 'vitest';
import { __test } from '../src/metering/index.mjs';
import { UPSTREAMS } from '../src/metering/upstreams.mjs';

const { sdxRankings } = __test;

// Trimmed copies of REAL upstream responses (curl'd 2026-07-24), not invented
// shapes. The detail that matters and would never be guessed: the two upstreams
// use DIFFERENT difficulty scales — rankingKeywords answers 0-1, mangools 0-100.
const RANKING = {
  statusCode: 200,
  body: {
    'media one business group': { rank: 1, search_volume: 140, url: 'https://mediaonemarketing.com.sg/', traffic: 43, difficulty: 0.12 },
    'lead generation agency': { rank: 2, search_volume: 90, url: 'https://mediaonemarketing.com.sg/our-services/lead-generation/', traffic: 15, difficulty: 0.55 },
    'internsg': { rank: 7, search_volume: 4400, url: 'https://mediaonemarketing.com.sg/internsg-review-new-star-job-portal/', traffic: 108, difficulty: 0.29 },
  },
};

// mangools returns a row for EVERY keyword asked for — unknown ones come back
// present but all-null, so "has a row" must not be read as "has data".
const METRICS = {
  statusCode: 200,
  body: {
    'seo services singapore': { search_volume: 770, cpc: 14.79, ppc: 15, difficulty: 26, difficulty_text: 'still easy' },
    'lead generation agency': { search_volume: 90, cpc: 6.65, ppc: 10, difficulty: 23, difficulty_text: 'still easy' },
    'zzzz nonexistent keyword qqq': { search_volume: null, cpc: null, ppc: null, difficulty: null, difficulty_text: null },
  },
};

const json = (o) => ({ ok: true, status: 200, text: async () => JSON.stringify(o) });
const realFetch = global.fetch;
afterEach(() => { global.fetch = realFetch; });

function mockUpstreams({ ranking = RANKING, metrics = METRICS } = {}) {
  global.fetch = async (url) => {
    if (String(url).startsWith(UPSTREAMS.rankingKeywords)) return json(ranking);
    if (String(url).startsWith(UPSTREAMS.mangoolsKeywords)) return json(metrics);
    throw new Error('unexpected upstream ' + url);
  };
}

describe('sdxRankings — SEO Diagnostics "Get rankings"', () => {
  it('fills volume and position for the keywords the user typed', async () => {
    mockUpstreams();
    const out = await sdxRankings({ input: 'mediaonemarketing.com.sg', keywords: ['lead generation agency', 'seo services singapore'] });
    const byKw = Object.fromEntries(out.rows.map((r) => [r.keyword, r]));

    // Ranks for this one → position comes from rankingKeywords.
    expect(byKw['lead generation agency'].position).toBe(2);
    expect(byKw['lead generation agency'].volume).toBe(90);
    // Doesn't rank → position stays null, but volume still arrives from mangools.
    // That's the "Not ranking" bucket, which is the point of the tool.
    expect(byKw['seo services singapore'].position).toBeNull();
    expect(byKw['seo services singapore'].volume).toBe(770);
    expect(out.matched).toBe(1);
  });

  it('normalises both difficulty scales onto 0-100', async () => {
    mockUpstreams();
    const out = await sdxRankings({ input: 'mediaonemarketing.com.sg', keywords: ['lead generation agency', 'seo services singapore'] });
    const byKw = Object.fromEntries(out.rows.map((r) => [r.keyword, r]));
    // rankingKeywords said 0.55 — shown as 55, not "0.55".
    expect(byKw['lead generation agency'].difficulty).toBe(55);
    // mangools said 26 — already 0-100, must NOT be multiplied again.
    expect(byKw['seo services singapore'].difficulty).toBe(26);
  });

  it('reports no difficulty rather than a confident KD 0 for an unknown keyword', async () => {
    // mangools sends `difficulty: null` for keywords it doesn't know, and
    // Number(null) === 0 — which would render as the easiest possible keyword.
    mockUpstreams();
    const out = await sdxRankings({ input: 'mediaonemarketing.com.sg', keywords: ['zzzz nonexistent keyword qqq'] });
    expect(out.rows[0].difficulty).toBeNull();
    expect(out.rows[0].volume).toBeNull();
  });

  it('matches keywords case-insensitively against the upstream spelling', async () => {
    mockUpstreams();
    const out = await sdxRankings({ input: 'mediaonemarketing.com.sg', keywords: ['  Lead Generation   Agency '] });
    expect(out.rows[0].position).toBe(2);
  });

  it('falls back to the domain’s own ranking keywords when nothing was typed', async () => {
    mockUpstreams();
    const out = await sdxRankings({ input: 'mediaonemarketing.com.sg', keywords: [] });
    expect(out.rows).toHaveLength(3);
    // Sorted by volume so the biggest opportunities are on top.
    expect(out.rows[0].keyword).toBe('internsg');
    expect(out.rows.every((r) => r.position != null)).toBe(true);
  });

  it('never invents a change — the Δ column has no upstream to come from', async () => {
    mockUpstreams();
    const out = await sdxRankings({ input: 'mediaonemarketing.com.sg', keywords: [] });
    expect(out.rows.every((r) => r.change === null)).toBe(true);
  });

  it('treats an upstream error envelope as no data rather than keyword rows', async () => {
    // An {errorType,errorMessage} body rendered as rows would surface
    // "errorMessage" as a keyword AND still bill for it.
    mockUpstreams({ ranking: { statusCode: 200, body: { errorType: 'Runtime.Error', errorMessage: 'boom' } }, metrics: { statusCode: 200, body: {} } });
    const out = await sdxRankings({ input: 'mediaonemarketing.com.sg', keywords: [] });
    expect(out._failed).toBe(true);
    expect(out.rows).toBeUndefined();
  });

  it('soft-fails without a domain instead of charging for a lookup it cannot do', async () => {
    mockUpstreams();
    const out = await sdxRankings({ input: '', keywords: ['seo services singapore'] });
    expect(out._failed).toBe(true);
  });

  it('stays out of run history — it is a step, not a run', async () => {
    mockUpstreams();
    const out = await sdxRankings({ input: 'mediaonemarketing.com.sg', keywords: [] });
    expect(out._skipHistory).toBe(true);
  });
});
