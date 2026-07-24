import { describe, it, expect, vi, beforeEach } from 'vitest';

// GET /s/{shareId}/run.json — the public report body behind a share link.
// Unauthenticated (anyone with the unguessable id), and it must return the run
// RESULT only: never `inputs`, which can carry API keys / connected-account ids.

let share = null;
let run = null;
vi.mock('../src/lib/dynamo.mjs', () => ({
  getShare: async () => share,
  getRun: async () => run,
  // Unused on the run.json path, but the handler module imports them.
  createShare: async () => {},
  revokeShare: async () => {},
  setRunShareId: async () => {},
  setRunTldr: async () => {},
}));

const { handler } = await import('../src/share/index.mjs');

const call = (shareId, tail = '/run.json') => handler({
  rawPath: `/s/${shareId}${tail}`,
  pathParameters: { shareId },
  requestContext: { http: { method: 'GET' } },
});
const bodyOf = (res) => JSON.parse(res.body);

beforeEach(() => {
  share = { shareId: 's1', userId: 'u1', runId: 'r1', revoked: false };
  run = {
    userId: 'u1', runId: 'r1', tool: 'onpage', toolName: 'On-Page SEO',
    target: 'example.com', ts: '2026-07-24T00:00:00.000Z',
    inputs: { url: 'https://example.com', _apiKey: 'secret', projectId: 'p9' },
    result: { html: '<h1>Report</h1>', sections: [{ type: 'stats', items: [] }] },
    tldr: 'Looking good: fast site. Do this next: add H1 tags.',
  };
});

describe('GET /s/{shareId}/run.json', () => {
  it('returns the run result for a live share', async () => {
    const res = await call('s1');
    expect(res.statusCode).toBe(200);
    const { run: out } = bodyOf(res);
    expect(out.tool).toBe('onpage');
    expect(out.toolName).toBe('On-Page SEO');
    expect(out.target).toBe('example.com');
    expect(out.ts).toBe('2026-07-24T00:00:00.000Z');
    expect(out.result).toEqual(run.result);
  });

  it('includes the persisted plain-English summary (tldr)', async () => {
    const out = bodyOf(await call('s1')).run;
    expect(out.tldr).toContain('Looking good');
  });

  it('tldr is null when the run never had one', async () => {
    delete run.tldr;
    const out = bodyOf(await call('s1')).run;
    expect(out.tldr).toBeNull();
  });

  it('NEVER exposes the original inputs (API keys, project ids)', async () => {
    const out = bodyOf(await call('s1')).run;
    expect(out).not.toHaveProperty('inputs');
    expect(JSON.stringify(out)).not.toContain('secret');
    expect(JSON.stringify(out)).not.toContain('_apiKey');
  });

  it('is CORS-open and cacheable', async () => {
    const res = await call('s1');
    expect(res.headers['Access-Control-Allow-Origin']).toBe('*');
    expect(res.headers['Content-Type']).toContain('application/json');
    expect(res.headers['Cache-Control']).toMatch(/max-age/);
  });

  it('404s a revoked share', async () => {
    share = { ...share, revoked: true };
    const res = await call('s1');
    expect(res.statusCode).toBe(404);
  });

  it('404s a missing share', async () => {
    share = null;
    const res = await call('missing');
    expect(res.statusCode).toBe(404);
  });

  it('falls back to a 404 when the share points at a deleted run', async () => {
    run = null;
    const res = await call('s1');
    expect(res.statusCode).toBe(404);
  });

  it('resolves a snapshot share (dashboard tools with no saved run)', async () => {
    share = { shareId: 's2', userId: 'u1', revoked: false, snapshot: {
      tool: 'report', toolName: 'Site Audit', target: '', tldr: 'Snapshot summary.',
      result: { sections: [{ type: 'stats', items: [{ label: 'Score', value: '92' }] }] },
    } };
    run = null; // no saved run — the snapshot supplies the body
    const res = await call('s2');
    expect(res.statusCode).toBe(200);
    const out = bodyOf(res).run;
    expect(out.toolName).toBe('Site Audit');
    expect(out.result.sections[0].items[0].value).toBe('92');
    expect(out.tldr).toBe('Snapshot summary.');
  });
});
