// The Finances balance sheet is a SaaS-product P&L, but the SaaS stack shares one
// AWS account (and one region) with ~160 internal tool Lambdas behind index.html /
// chatbot.html. These tests pin the two mechanisms that keep the fleet's cost out
// of the SaaS sheet — and the fallback that stops the sheet reporting a fake US$0
// cost base during the window before the cost-allocation tag starts recording.
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Cost Explorer responses this fake will serve, keyed by whether the request
// carried a Filter (tag-scoped) or not (whole account).
let tagged = 0;
let account = 0;
let sentFilters = [];

vi.mock('@aws-sdk/client-cost-explorer', () => {
  class GetCostAndUsageCommand {
    constructor(input) { this.input = input; }
  }
  class CostExplorerClient {
    async send(cmd) {
      const { Filter } = cmd.input;
      sentFilters.push(Filter);
      const amount = Filter ? tagged : account;
      return {
        ResultsByTime: [{
          Estimated: false,
          Groups: amount > 0 ? [{ Keys: ['AWS Lambda'], Metrics: { UnblendedCost: { Amount: String(amount) } } }] : [],
        }],
      };
    }
  }
  return { CostExplorerClient, GetCostAndUsageCommand };
});

const { financeReport } = await import('../src/lib/finances.mjs');

const range = { from: new Date('2026-07-01T00:00:00Z'), to: new Date('2026-07-22T00:00:00Z') };
const report = (consumed) => financeReport({ ...range, users: [], consumed });

beforeEach(() => { sentFilters = []; });

describe('AWS cost scoping', () => {
  it('reports the tag-filtered figure when the tag has cost data', async () => {
    tagged = 24.5; account = 141.16;
    const r = await report({ credits: 0, byTool: [] });
    expect(r.cost.aws.usd).toBe(24.5);
    expect(r.cost.aws.scope).toBe('saas');
    expect(r.cost.aws.note).toBeUndefined();
    // Only the filtered query runs — no wasted second Cost Explorer call (~US$0.01).
    expect(sentFilters).toHaveLength(1);
    expect(sentFilters[0].Tags).toEqual({ Key: 'product', Values: ['saas'], MatchOptions: ['EQUALS'] });
  });

  it('falls back to whole-account spend, flagged, when the tag has no data yet', async () => {
    // AWS records a tag against cost data only from its activation date and never
    // backfills, so a window before activation returns US$0 for a live stack.
    tagged = 0; account = 141.16;
    const r = await report({ credits: 0, byTool: [] });
    expect(r.cost.aws.usd).toBe(141.16);
    expect(r.cost.aws.scope).toBe('account');
    expect(r.cost.aws.note).toMatch(/whole-account/i);
    expect(sentFilters).toHaveLength(2);
  });

  it('keeps a genuine zero as SaaS scope rather than falling back', async () => {
    tagged = 0; account = 0;
    const r = await report({ credits: 0, byTool: [] });
    expect(r.cost.aws.usd).toBe(0);
    expect(r.cost.aws.scope).toBe('saas');
    expect(r.cost.aws.note).toBeUndefined();
  });
});

describe('COGS scoping', () => {
  beforeEach(() => { tagged = 10; account = 10; });

  it('costs only SaaS-sourced credits and reports the excluded cockpit spend', async () => {
    const r = await report({ credits: 2000, byTool: [{ tool: 'rank', credits: 2000 }], source: 'saas', excluded: { index: 715 } });
    expect(r.cost.cogs.usd).toBe(24); // 2000 × 0.012 — the 715 index credits are NOT added
    expect(r.cost.cogs.source).toBe('saas');
    expect(r.cost.cogs.excluded).toEqual({ index: 715 });
    expect(r.cost.total).toBe(34); // 10 AWS + 24 COGS
  });
});
