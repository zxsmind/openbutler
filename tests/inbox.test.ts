import { describe, expect, it, vi } from 'vitest';
import { AgentInbox, inboxId, inboxNotice, type InboxSource } from '../src/inbox.js';
import { createInboxTool } from '../src/tools/inbox.js';
import { ownerInboxToolResultToModelMessages, summarizeOwnerInboxToolResult } from '../src/image.js';

function source(name: string, references = ['first', 'second']): InboxSource {
  const read = new Set<string>();
  const handled = new Set<string>();
  return {
    name,
    list: async () => ({
      items: references
        .filter((id) => !handled.has(id))
        .map((reference, index) => ({
          reference,
          receivedAt: `2026-10-18T00:00:0${index}Z`,
          state: read.has(reference) ? 'read' : 'unread',
        })),
    }),
    read: vi.fn(async (ids: readonly string[], sessionId: string) =>
      ids.map((reference) => {
        read.add(reference);
        return { reference, content: { text: `content:${name}:${reference}`, reader: sessionId } };
      }),
    ),
    acknowledge: vi.fn(async (ids: readonly string[]) => {
      for (const id of ids) handled.add(id);
      return { acknowledged: ids.length };
    }),
  };
}

describe('one extensible agent inbox', () => {
  it('merges sources without exposing payloads or consuming notifications on list', async () => {
    const inbox = new AgentInbox();
    for (const name of ['Telegram', 'Team', 'Subagent', 'Calendar']) inbox.register(source(name, ['one']));
    const first = await inbox.execute({ action: 'list' }, 'parent');
    expect(first).toMatchObject({
      sources: [
        { source: 'Telegram', unread: 1 },
        { source: 'Team', unread: 1 },
        { source: 'Subagent', unread: 1 },
        { source: 'Calendar', unread: 1 },
      ],
      items: expect.any(Array),
    });
    expect(JSON.stringify(first)).not.toContain('content:');
    expect(await inbox.execute({ action: 'list' }, 'parent')).toEqual(first);
    expect(inboxNotice('Calendar', 1)).toBe('You have 1 "Calendar" notification. Use inbox to read.');
  });

  it('keeps read-but-unhandled items visible and routes acknowledgement through the same id', async () => {
    const inbox = new AgentInbox();
    const backend = source('Team');
    inbox.register(backend);
    await inbox.execute({ action: 'read', ids: [inboxId('Team', 'first')] }, 'parent');
    expect(await inbox.execute({ action: 'list' }, 'parent')).toMatchObject({ items: [{ state: 'read' }, { state: 'unread' }] });
    await inbox.execute({ action: 'acknowledge', ids: [inboxId('Team', 'first')] }, 'parent');
    expect(backend.acknowledge).toHaveBeenCalledWith(['first'], 'parent');
    expect(await inbox.execute({ action: 'list' }, 'parent')).toMatchObject({ items: [{ id: 'Team:second' }] });
  });

  it('reads the next unread page and keeps each source read batched', async () => {
    const inbox = new AgentInbox();
    const backend = source('Telegram');
    inbox.register(backend);
    expect(await inbox.execute({ action: 'read', limit: 1 }, 'parent')).toMatchObject({ items: [{ id: 'Telegram:first' }] });
    expect(await inbox.execute({ action: 'read' }, 'parent')).toMatchObject({ items: [{ id: 'Telegram:second' }] });
    expect(backend.read).toHaveBeenLastCalledWith(['second'], 'parent');
  });

  it('paginates metadata, filters arbitrary sources and round-trips opaque references', async () => {
    const inbox = new AgentInbox();
    const backend = source('A source', ['ref:with / characters', 'second']);
    inbox.register(backend);
    expect(await inbox.execute({ action: 'list', source: 'A source', offset: 1, limit: 1 }, 'parent')).toMatchObject({
      items: [{ id: inboxId('A source', 'second') }],
      remaining: 0,
    });
    await inbox.execute({ action: 'read', ids: [inboxId('A source', 'ref:with / characters')] }, 'parent');
    expect(backend.read).toHaveBeenCalledWith(['ref:with / characters'], 'parent');
  });

  it('keeps healthy sources available while surfacing failures', async () => {
    const inbox = new AgentInbox();
    inbox.register({
      ...source('Offline'),
      list: async () => {
        throw new Error('offline');
      },
    });
    inbox.register(source('Telegram', ['one']));
    expect(await inbox.execute({ action: 'list' }, 'parent')).toMatchObject({
      items: [{ source: 'Telegram' }],
      errors: [{ source: 'Offline', error: 'offline' }],
    });
  });

  it('does not route malformed, unknown or cross-source ids to a backend', async () => {
    const inbox = new AgentInbox();
    const backend = source('Team');
    inbox.register(backend);
    for (const ids of [['no-prefix'], ['Unknown:x'], ['Team:%xx'], ['Team:']])
      expect(await inbox.execute({ action: 'read', ids }, 'parent')).toMatchObject({ status: 'invalid' });
    expect(await inbox.execute({ action: 'read', source: 'Team', ids: ['Telegram:x'] }, 'parent')).toMatchObject({ status: 'invalid' });
    expect(await inbox.execute({ action: 'read', ids: ['Team:first'] }, undefined)).toMatchObject({ status: 'denied' });
    expect(backend.read).not.toHaveBeenCalled();
    expect(() => inbox.register(backend)).toThrow('already registered');
  });

  it('validates the single tool contract and preserves the caller identity', async () => {
    const execute = vi.fn(async () => ({ status: 'ok' }));
    const tool = createInboxTool(execute);
    await tool.execute({ action: 'read', ids: ['Subagent:child'] }, undefined, { sessionId: 'parent' });
    expect(execute).toHaveBeenCalledWith({ action: 'read', ids: ['Subagent:child'] }, 'parent');
    for (const input of [
      {},
      { action: 'acknowledge' },
      { action: 'read', ids: [] },
      { action: 'list', limit: 21 },
      { action: 'list', offset: -1 },
    ])
      expect(await tool.execute(input)).toMatchObject({ status: 'invalid' });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('preserves mixed source content while promoting only authenticated owner messages', () => {
    const output = {
      type: 'inbox',
      items: [
        {
          id: 'Telegram:one',
          source: 'Telegram',
          content: {
            type: 'owner-inbox',
            messages: [{ id: 'one', source: 'telegram', receivedAt: '2026-10-18T00:00:00Z', text: 'OWNER_REQUEST' }],
          },
        },
        { id: 'Team:one', source: 'Team', content: { text: 'PEER_REPORT' } },
        { id: 'Subagent:one', source: 'Subagent', content: { report: 'WORKER_REPORT', completionRevision: 2, session: 'one' } },
      ],
    };
    const userMessages = ownerInboxToolResultToModelMessages(output);
    expect(userMessages).toHaveLength(1);
    expect(JSON.stringify(userMessages)).toContain('OWNER_REQUEST');
    expect(JSON.stringify(userMessages)).not.toContain('PEER_REPORT');
    const summary = summarizeOwnerInboxToolResult(output)!;
    expect(summary).toContain('PEER_REPORT');
    expect(summary).toContain('WORKER_REPORT');
    expect(summary).not.toContain('OWNER_REQUEST');
  });
});
