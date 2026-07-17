import { describe, it, expect, vi, beforeEach } from 'vitest';
import { isUsername, isEmail } from '../src/lib/http.mjs';

describe('isUsername', () => {
  it('accepts ordinary handles', () => {
    expect(isUsername('kenneth')).toBe(true);
    expect(isUsername('jane_doe')).toBe(true);
    expect(isUsername('a.b-c_1')).toBe(true);
    expect(isUsername('abc')).toBe(true);              // min length
    expect(isUsername('a'.repeat(30))).toBe(true);     // max length
  });

  it('enforces length bounds', () => {
    expect(isUsername('ab')).toBe(false);              // < 3
    expect(isUsername('a'.repeat(31))).toBe(false);    // > 30
    expect(isUsername('')).toBe(false);
  });

  it('requires alphanumeric first and last characters', () => {
    expect(isUsername('_leading')).toBe(false);
    expect(isUsername('trailing.')).toBe(false);
    expect(isUsername('-nope-')).toBe(false);
  });

  it('rejects non-strings and whitespace', () => {
    expect(isUsername(null)).toBe(false);
    expect(isUsername(12345)).toBe(false);
    expect(isUsername('has space')).toBe(false);
    expect(isUsername('tab\there')).toBe(false);
  });

  it('rejects reserved handles, case-insensitively', () => {
    expect(isUsername('admin')).toBe(false);
    expect(isUsername('AdMiN')).toBe(false);
    expect(isUsername('support')).toBe(false);
    // Key-prefix words: a `username:` reservation item must never be claimable.
    expect(isUsername('settings')).toBe(false);
    expect(isUsername('username')).toBe(false);
    expect(isUsername('pending')).toBe(false);
  });

  // The sign-in handler routes an identifier by testing isEmail first, so the
  // two namespaces MUST NOT overlap — an identifier that satisfied both would
  // be ambiguous, and a username that parsed as an email could shadow a real
  // account's address.
  it('never accepts anything that parses as an email, and vice versa', () => {
    for (const s of ['you@company.com', 'a@b.co', 'first.last@sub.domain.org']) {
      expect(isEmail(s)).toBe(true);
      expect(isUsername(s)).toBe(false);
    }
    for (const s of ['kenneth', 'jane_doe', 'a.b-c_1']) {
      expect(isUsername(s)).toBe(true);
      expect(isEmail(s)).toBe(false);
    }
  });
});

// ── Uniqueness reservations ─────────────────────────────────────────────────
// A GSI can't enforce uniqueness, so reserveUsername carries it via a
// conditional write. These assert the conditional actually gates the claim and
// that a ConditionalCheckFailedException reads as "taken" rather than throwing.
const send = vi.hoisted(() => vi.fn());
vi.mock('@aws-sdk/lib-dynamodb', async (orig) => {
  const actual = await orig();
  return { ...actual, DynamoDBDocumentClient: { from: () => ({ send }) } };
});
vi.mock('../src/lib/crypto.mjs', () => ({ encrypt: (v) => v, decrypt: (v) => v }));

const { reserveUsername, releaseUsername } = await import('../src/lib/dynamo.mjs');

const conditionalFail = () => Object.assign(new Error('conditional'), { name: 'ConditionalCheckFailedException' });

describe('reserveUsername', () => {
  beforeEach(() => send.mockReset());

  it('claims a free handle and keys the item by lowercase', async () => {
    send.mockResolvedValueOnce({});
    expect(await reserveUsername('Kenneth', 'local:1')).toBe(true);
    const { Item, ConditionExpression } = send.mock.calls[0][0].input;
    expect(Item.userId).toBe('username:kenneth'); // case-folded key
    expect(Item.ownerId).toBe('local:1');
    expect(ConditionExpression).toContain('attribute_not_exists(userId)');
  });

  it('reports a handle held by someone else as taken, not an error', async () => {
    send.mockRejectedValueOnce(conditionalFail());
    expect(await reserveUsername('taken', 'local:2')).toBe(false);
  });

  it('is idempotent for the current owner (safe to retry)', async () => {
    send.mockResolvedValueOnce({});
    expect(await reserveUsername('mine', 'local:1')).toBe(true);
    expect(send.mock.calls[0][0].input.ExpressionAttributeValues).toEqual({ ':me': 'local:1' });
  });

  it('propagates non-conditional failures instead of silently reporting taken', async () => {
    send.mockRejectedValueOnce(Object.assign(new Error('boom'), { name: 'ProvisionedThroughputExceededException' }));
    await expect(reserveUsername('x', 'local:1')).rejects.toThrow('boom');
  });
});

describe('releaseUsername', () => {
  beforeEach(() => send.mockReset());

  it('only deletes a reservation the caller still owns', async () => {
    send.mockResolvedValueOnce({});
    await releaseUsername('old', 'local:1');
    const { Key, ConditionExpression, ExpressionAttributeValues } = send.mock.calls[0][0].input;
    expect(Key).toEqual({ userId: 'username:old' });
    expect(ConditionExpression).toBe('ownerId = :me');
    expect(ExpressionAttributeValues).toEqual({ ':me': 'local:1' });
  });

  it('swallows a lost race — the handle now belongs to someone else', async () => {
    send.mockRejectedValueOnce(conditionalFail());
    await expect(releaseUsername('old', 'local:1')).resolves.toBeUndefined();
  });

  it('no-ops without a username (nothing to release)', async () => {
    await releaseUsername(null, 'local:1');
    expect(send).not.toHaveBeenCalled();
  });
});
