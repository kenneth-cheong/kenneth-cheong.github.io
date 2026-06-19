import { describe, it, expect } from 'vitest';
import { __test } from '../src/metering/index.mjs';

describe('gateway pure helpers', () => {
  it('schemaRun builds valid nested JSON-LD', () => {
    const r = __test.schemaRun({ type: 'Product', name: 'W', offers_price: '9.99', offers_priceCurrency: 'SGD' });
    const j = JSON.parse(r.text);
    expect(j['@type']).toBe('Product');
    expect(j.offers.price).toBe('9.99');
  });
  it('difficultyToTime buckets correctly', () => {
    expect(__test.difficultyToTime(10)).toBe('0-3 months');
    expect(__test.difficultyToTime(80)).toBe('more than 12 months');
  });
  it('cleanDomain strips protocol/www/path', () => {
    expect(__test.cleanDomain('https://www.x.co/page')).toBe('x.co');
  });
  it('kwRows maps requested columns', () => {
    const rows = __test.kwRows({ a: { search_volume: 100, difficulty: 20, cpc: 1.5 } }, ['volume', 'difficulty', 'cpc']);
    expect(rows[0]).toMatchObject({ keyword: 'a', volume: 100, difficulty: 20 });
  });
  it('classifyAnchor flags generic + empty', () => {
    expect(__test.classifyAnchor('click here', 'seo', ['seo']).priority).toBe('HIGH');
    expect(__test.classifyAnchor('', 'seo', ['seo']).priority).toBe('CRITICAL');
  });
  it('parseAgentResult splits JSON header from content', () => {
    const p = __test.parseAgentResult('{"summary":"ok","score":8}\n---CONTENT---\nbody text');
    expect(p.summary).toBe('ok');
    expect(p.content).toBe('body text');
  });
  it('parseScaAnswer unwraps the Social Media Audit strategy envelope', () => {
    // 1) plain object answer
    expect(__test.parseScaAnswer({ answer: { executive_summary: 'a' } }).executive_summary).toBe('a');
    // 2) fenced JSON string answer
    expect(__test.parseScaAnswer({ answer: '```json\n{"overall_health":"Strong"}\n```' }).overall_health).toBe('Strong');
    // 3) doubly-wrapped proxy envelope { body: "{ answer: ... }" }
    expect(__test.parseScaAnswer({ body: JSON.stringify({ answer: { gaps: ['x'] } }) }).gaps).toEqual(['x']);
    // 4) unparseable → null (caller turns this into a soft failure)
    expect(__test.parseScaAnswer({ answer: 'not json' })).toBeNull();
  });
});

describe('crawlRun (mocked upstream)', () => {
  it('aggregates pages + summary', async () => {
    global.fetch = async (url, opts) => {
      const b = JSON.parse(opts.body);
      const j = (o) => ({ ok: true, status: 200, text: async () => JSON.stringify(o) });
      if (b.action === 'initiate') return j({ tasks: [{ id: 't1' }] });
      if (b.action === 'get_results') return j({ tasks: [{ result: [{ crawl_progress: 'finished', items: [{ url: 'https://x/', status_code: 200, onpage_score: 90, meta: { title: 'T', description: 'd', htags: { h1: ['H'] } }, checks: { is_https: true } }] }] }] });
      return j({});
    };
    const r = await __test.crawlRun({ input: 'https://x', maxPages: '2', maxDepth: '2' }, { id: 'technical-seo' });
    expect(r.rows.length).toBe(1);
    expect(r.rows[0].issues).toBe(0);
    expect(r.summary.pagesCrawled).toBe(1);
  }, 20000);
});
