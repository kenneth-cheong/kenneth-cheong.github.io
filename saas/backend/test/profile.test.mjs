import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  isProfileComplete, profileProgress, profileValueFilled,
  PROFILE_REQUIRED_KEYS, PROFILE_FIELDS,
} from '../../shared/catalog.mjs';

// ── Pure schema helpers (shared front/back completion rule) ──────────────────
describe('profile completion helpers', () => {
  // A profile with every required key filled (multiselect → non-empty array).
  const fullProfile = () => {
    const p = {};
    for (const f of PROFILE_FIELDS) {
      if (!f.required) continue;
      p[f.key] = f.type === 'multiselect' ? [f.options[0]] : (f.options ? f.options[0] : 'x');
    }
    return p;
  };

  it('profileValueFilled treats empty string / [] / null as unfilled', () => {
    expect(profileValueFilled('')).toBe(false);
    expect(profileValueFilled('   ')).toBe(false);
    expect(profileValueFilled([])).toBe(false);
    expect(profileValueFilled(null)).toBe(false);
    expect(profileValueFilled('hi')).toBe(true);
    expect(profileValueFilled(['a'])).toBe(true);
  });

  it('isProfileComplete is false until every required key is filled', () => {
    expect(isProfileComplete({})).toBe(false);
    expect(isProfileComplete(null)).toBe(false);
    const p = fullProfile();
    expect(isProfileComplete(p)).toBe(true);
    // Drop one required key → incomplete again.
    delete p[PROFILE_REQUIRED_KEYS[0]];
    expect(isProfileComplete(p)).toBe(false);
  });

  it('optional fields do NOT count toward completion', () => {
    const optional = PROFILE_FIELDS.find((f) => !f.required);
    expect(optional).toBeTruthy();
    const p = fullProfile(); // already complete without optionals
    expect(isProfileComplete(p)).toBe(true);
    expect(PROFILE_REQUIRED_KEYS).not.toContain(optional.key);
  });

  it('profileProgress counts answered required fields', () => {
    expect(profileProgress({})).toEqual({ done: 0, total: PROFILE_REQUIRED_KEYS.length });
    const one = { [PROFILE_REQUIRED_KEYS[0]]: 'x' };
    expect(profileProgress(one)).toEqual({ done: 1, total: PROFILE_REQUIRED_KEYS.length });
  });
});

// ── claimProfileBonus: at-most-once grant under the conditional claim ─────────
const h = vi.hoisted(() => {
  process.env.USERS_TABLE = 'users';
  process.env.LEDGER_TABLE = 'ledger';
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

const ccf = () => Object.assign(new Error('conditional check failed'), { name: 'ConditionalCheckFailedException' });
const isClaim = (cmd) => cmd._type === 'Update' && String(cmd.input.ConditionExpression || '').includes('profileBonusGrantedAt');

let dynamo;
beforeEach(async () => { h.send = null; dynamo = await import('../src/lib/dynamo.mjs'); });

describe('claimProfileBonus', () => {
  it('grants the bonus exactly once when the claim wins', async () => {
    let grants = 0;
    h.send = async (cmd) => {
      if (isClaim(cmd)) return {};                              // claim slot won
      if (cmd._type === 'Update') { grants++; return { Attributes: { credits: 0, topupCredits: 50 } }; } // grantTopupCredits
      if (cmd._type === 'Put') return {};                      // ledger row
      return {};
    };
    const granted = await dynamo.claimProfileBonus({ userId: 'u', amount: 50 });
    expect(granted).toBe(true);
    expect(grants).toBe(1);
  });

  it('does NOT grant again when the slot was already claimed', async () => {
    let grants = 0;
    h.send = async (cmd) => {
      if (isClaim(cmd)) throw ccf();                            // already claimed
      if (cmd._type === 'Update') { grants++; return { Attributes: {} }; }
      return {};
    };
    const granted = await dynamo.claimProfileBonus({ userId: 'u', amount: 50 });
    expect(granted).toBe(false);
    expect(grants).toBe(0);
  });
});
