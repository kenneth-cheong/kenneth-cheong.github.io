import { describe, it, expect, vi, beforeEach } from 'vitest';

// Staff-shared canned reply templates live on the settings singleton. We mock
// the DynamoDB document client and keep a single in-memory item for
// `settings:global`, so create/edit/delete round-trip through real code.
const h = vi.hoisted(() => {
  process.env.USERS_TABLE = 'users';
  process.env.LEDGER_TABLE = 'ledger';
  process.env.CACHE_TABLE = 'cache';
  return { settings: null };
});

vi.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: class {} }));
vi.mock('@aws-sdk/lib-dynamodb', () => {
  const mk = (type) => class { constructor(input) { this.input = input; this._type = type; } };
  return {
    DynamoDBDocumentClient: { from: () => ({ send: (cmd) => {
      if (cmd._type === 'Get') return { Item: h.settings || undefined };
      if (cmd._type === 'Put') { h.settings = cmd.input.Item; return {}; }
      return {};
    } }) },
    GetCommand: mk('Get'), PutCommand: mk('Put'), UpdateCommand: mk('Update'),
    QueryCommand: mk('Query'), ScanCommand: mk('Scan'), DeleteCommand: mk('Delete'),
    BatchWriteCommand: mk('Batch'),
  };
});

const dynamo = await import('../src/lib/dynamo.mjs');

beforeEach(() => { h.settings = null; });

describe('ticket reply templates', () => {
  it('creates, lists, edits, and deletes a template', async () => {
    // Empty until one is saved.
    expect(await dynamo.listTicketTemplates()).toEqual([]);

    // Create.
    const { template } = await dynamo.saveTicketTemplate({ title: 'Billing', body: 'Hi {{name}}', editorEmail: 'a@x.co' });
    expect(template.id).toMatch(/^tpl_/);
    expect(template.title).toBe('Billing');
    expect(template.createdBy).toBe('a@x.co');
    let list = await dynamo.listTicketTemplates();
    expect(list).toHaveLength(1);

    // Edit (same id → in place, no duplicate).
    const edited = await dynamo.saveTicketTemplate({ id: template.id, title: 'Billing & credits', body: 'Updated', editorEmail: 'b@x.co' });
    expect(edited.template.title).toBe('Billing & credits');
    expect(edited.templates).toHaveLength(1);
    expect(edited.template.updatedBy).toBe('b@x.co');

    // Delete → empty again.
    const del = await dynamo.deleteTicketTemplate({ id: template.id });
    expect(del.templates).toEqual([]);
    expect(await dynamo.listTicketTemplates()).toEqual([]);
  });

  it('rejects an empty title or body', async () => {
    await expect(dynamo.saveTicketTemplate({ title: '', body: 'x' })).rejects.toThrow(/required/i);
    await expect(dynamo.saveTicketTemplate({ title: 'x', body: '   ' })).rejects.toThrow(/required/i);
  });

  it('rejects editing an unknown id', async () => {
    await expect(dynamo.saveTicketTemplate({ id: 'tpl_missing', title: 'a', body: 'b' })).rejects.toThrow(/not found/i);
  });

  it('does not surface templates through the public settings view', async () => {
    await dynamo.saveTicketTemplate({ title: 'T', body: 'B' });
    const settings = await dynamo.getSettings();
    expect(settings.ticketTemplates).toBeUndefined();
  });
});
