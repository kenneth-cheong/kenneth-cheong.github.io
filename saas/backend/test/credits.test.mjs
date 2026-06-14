import { describe, it, expect, vi, beforeEach } from 'vitest';

// Credit accounting + webhook idempotency are the money-critical paths. We mock
// the DynamoDB document client so we can drive each branch deterministically.
const h = vi.hoisted(() => {
  process.env.USERS_TABLE = 'users';
  process.env.LEDGER_TABLE = 'ledger';
  process.env.CACHE_TABLE = 'cache';
  return { send: null };
});

vi.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: class {} }));
vi.mock('@aws-sdk/lib-dynamodb', () => {
  const mk = (type) => class { constructor(input) { this.input = input; this._type = type; } };
  return {
    DynamoDBDocumentClient: { from: () => ({ send: (cmd) => h.send(cmd) }) },
    GetCommand: mk('Get'), PutCommand: mk('Put'), UpdateCommand: mk('Update'),
    QueryCommand: mk('Query'), ScanCommand: mk('Scan'), DeleteCommand: mk('Delete'),
    BatchWriteCommand: mk('Batch'),
  };
});

const dynamo = await import('../src/lib/dynamo.mjs');
const ccf = () => Object.assign(new Error('conditional check failed'), { name: 'ConditionalCheckFailedException' });

beforeEach(() => { h.send = null; });

describe('spendCredits', () => {
  it('spends monthly first, then top-up', async () => {
    h.send = async (cmd) => {
      if (cmd._type === 'Get') return { Item: { userId: 'u', credits: 10, topupCredits: 5 } };
      if (cmd._type === 'Update') return { Attributes: { credits: cmd.input.ExpressionAttributeValues[':nm'], topupCredits: cmd.input.ExpressionAttributeValues[':nt'] } };
      return {};
    };
    const r = await dynamo.spendCredits({ userId: 'u', cost: 8, tool: 't' });
    expect(r).toEqual({ credits: 2, topupCredits: 5, total: 7 });
  });

  it('overflows into top-up when monthly is short', async () => {
    h.send = async (cmd) => {
      if (cmd._type === 'Get') return { Item: { credits: 10, topupCredits: 5 } };
      if (cmd._type === 'Update') return { Attributes: { credits: cmd.input.ExpressionAttributeValues[':nm'], topupCredits: cmd.input.ExpressionAttributeValues[':nt'] } };
      return {};
    };
    const r = await dynamo.spendCredits({ userId: 'u', cost: 12 });
    expect(r.credits).toBe(0);
    expect(r.topupCredits).toBe(3);
  });

  it('throws insufficient_credits when the balance is too low', async () => {
    h.send = async (cmd) => (cmd._type === 'Get' ? { Item: { credits: 1, topupCredits: 1 } } : {});
    await expect(dynamo.spendCredits({ userId: 'u', cost: 5 })).rejects.toMatchObject({ code: 'insufficient_credits' });
  });

  it('retries on optimistic-lock contention, then commits', async () => {
    let updates = 0;
    h.send = async (cmd) => {
      if (cmd._type === 'Get') return { Item: { credits: 10, topupCredits: 0 } };
      if (cmd._type === 'Update') { updates++; if (updates === 1) throw ccf(); return { Attributes: { credits: cmd.input.ExpressionAttributeValues[':nm'], topupCredits: cmd.input.ExpressionAttributeValues[':nt'] } }; }
      return {};
    };
    const r = await dynamo.spendCredits({ userId: 'u', cost: 4 });
    expect(updates).toBe(2);
    expect(r.credits).toBe(6);
  });
});

describe('claimStripeEvent (webhook idempotency)', () => {
  it('claims a new event id and rejects a duplicate', async () => {
    h.send = async () => ({}); // conditional Put succeeds
    expect(await dynamo.claimStripeEvent('evt_1')).toBe(true);
    h.send = async () => { throw ccf(); }; // id already present
    expect(await dynamo.claimStripeEvent('evt_1')).toBe(false);
  });
});

describe('debitTopupCredits (refund clawback)', () => {
  it('claws back the requested amount', async () => {
    h.send = async (cmd) => {
      if (cmd._type === 'Get') return { Item: { credits: 0, topupCredits: 5 } };
      if (cmd._type === 'Update') return { Attributes: { credits: 0, topupCredits: cmd.input.ExpressionAttributeValues[':n'] } };
      return {};
    };
    const r = await dynamo.debitTopupCredits({ userId: 'u', amount: 3 });
    expect(r.topupCredits).toBe(2);
  });

  it('floors at zero (never negative)', async () => {
    let written = null;
    h.send = async (cmd) => {
      if (cmd._type === 'Get') return { Item: { credits: 0, topupCredits: 2 } };
      if (cmd._type === 'Update') { written = cmd.input.ExpressionAttributeValues[':n']; return { Attributes: { topupCredits: written } }; }
      return {};
    };
    await dynamo.debitTopupCredits({ userId: 'u', amount: 5 });
    expect(written).toBe(0);
  });

  it('is a no-op when there are no top-up credits', async () => {
    let updateCalled = false;
    h.send = async (cmd) => {
      if (cmd._type === 'Update') updateCalled = true;
      if (cmd._type === 'Get') return { Item: { credits: 5, topupCredits: 0 } };
      return {};
    };
    await dynamo.debitTopupCredits({ userId: 'u', amount: 3 });
    expect(updateCalled).toBe(false);
  });
});

describe('resetMonthlyAllowance (billing cycle)', () => {
  it('hard-resets credits, sets tier/periodEnd, and clears pastDue — without touching top-up', async () => {
    let upd;
    h.send = async (cmd) => {
      if (cmd._type === 'Update') { upd = cmd; return { Attributes: { credits: 1000, topupCredits: 7 } }; }
      return {};
    };
    await dynamo.resetMonthlyAllowance({ userId: 'u', tier: 'pro', monthlyCredits: 1000, periodEnd: '2026-07-01', previousCredits: 3 });
    expect(upd.input.UpdateExpression).toContain('REMOVE pastDue');
    expect(upd.input.UpdateExpression).not.toContain('topupCredits');
    expect(upd.input.ExpressionAttributeValues[':c']).toBe(1000);
    expect(upd.input.ExpressionAttributeValues[':t']).toBe('pro');
  });
});
