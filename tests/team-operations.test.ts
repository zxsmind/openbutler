import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TeamOperations, TeamError } from '../src/team/operations.js';
import { hashTicket, makeTicket, validateMemberName } from '../src/team/service.js';
import { TeamStore } from '../src/team/store.js';

let dataDir: string;
let store: TeamStore;
let operations: TeamOperations;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'ranite-team-ops-'));
  store = new TeamStore(join(dataDir, 'team.db'));
  const now = Date.now();
  store.initHub('hub-id', 'team-id', 'MyTeam', 'Atreus-Ranite', now);
  store.createJoinRequest('jr_m', 'Murphy-Ranite', 'kartal-1', now);
  const ticket = makeTicket();
  store.decideJoin('jr_m', true, ticket, hashTicket(ticket), now);
  operations = new TeamOperations(store);
});

afterEach(() => {
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('recipient resolution', () => {
  it('stores a direct message under the recipient canonical name, whatever the sender typed', () => {
    const result = operations.postMessage('Atreus-Ranite', { recipient: 'murphy-ranite', body: 'hi' });
    expect(result.duplicate).toBe(false);
    if (result.duplicate) throw new Error('unreachable');
    expect(result.message.recipient).toBe('Murphy-Ranite');
    // The real member sees it; the sender's spelling does not create a phantom recipient.
    expect(store.unreadDmCount('Murphy-Ranite')).toBe(1);
  });

  it('treats the group recipient case-insensitively as the shared channel', () => {
    const result = operations.postMessage('Atreus-Ranite', { recipient: 'Group', body: 'team!' });
    if (result.duplicate) throw new Error('unreachable');
    expect(result.message.recipient).toBe('group');
    expect(store.groupLatestSeq()).toBe(result.message.seq);
  });

  it('refuses an unknown or invalid recipient', () => {
    expect(() => operations.postMessage('Atreus-Ranite', { recipient: 'ghost', body: 'hi' })).toThrow(TeamError);
    expect(() => operations.postMessage('Atreus-Ranite', { recipient: 'has space', body: 'hi' })).toThrow(TeamError);
  });
});

describe('message rules live in one place', () => {
  it('refuses an empty body and an over-long body', () => {
    expect(() => operations.postMessage('Atreus-Ranite', { recipient: 'group', body: '   ' })).toThrow(/cannot be empty/);
    expect(() => operations.postMessage('Atreus-Ranite', { recipient: 'group', body: 'x'.repeat(8001) })).toThrow(/limited to/);
  });

  it('recognises a repeated message id as a retry, never storing it twice', () => {
    const first = operations.postMessage('Atreus-Ranite', { recipient: 'group', body: 'once', msgId: 'm_fixed' });
    const again = operations.postMessage('Atreus-Ranite', { recipient: 'group', body: 'once', msgId: 'm_fixed' });
    expect(first.duplicate).toBe(false);
    expect(again.duplicate).toBe(true);
    expect(store.groupLatestSeq()).toBe(1);
  });

  it('applies the same rules to shared-memory writes', () => {
    expect(() => operations.appendMemory('Atreus-Ranite', 'decisions', '   ')).toThrow(/cannot be empty/);
    expect(() => operations.appendMemory('Atreus-Ranite', 'nope' as never, 'x')).toThrow(/topic must be/);
    expect(operations.appendMemory('Atreus-Ranite', 'decisions', 'ok')).toBe(1);
  });
});

describe('reserved names', () => {
  it('refuses the group name as a member, case-insensitively', () => {
    expect(() => validateMemberName('group')).toThrow(/reserved/);
    expect(() => validateMemberName('GROUP')).toThrow(/reserved/);
    expect(validateMemberName('Group-Lead')).toBe('Group-Lead');
  });
});

describe('reading and replying close a direct message', () => {
  it('consumes what it returns, so a read message never comes back', () => {
    operations.postMessage('Atreus-Ranite', { recipient: 'Murphy-Ranite', body: 'task one' });
    const first = store.unreadDms('Murphy-Ranite', 50);
    expect(first).toHaveLength(1);
    store.ackDms(
      'Murphy-Ranite',
      first.map((message) => message.msgId),
      Date.now(),
    );
    expect(store.unreadDmCount('Murphy-Ranite')).toBe(0);
  });

  it('acknowledges the message a reply answers, for the sender', () => {
    const incoming = operations.postMessage('Atreus-Ranite', { recipient: 'Murphy-Ranite', body: 'please handle' });
    if (incoming.duplicate) throw new Error('unreachable');
    expect(store.unreadDmCount('Murphy-Ranite')).toBe(1);
    // Murphy replies to the message; the reply closes it without a separate step.
    operations.postMessage('Murphy-Ranite', { recipient: 'Atreus-Ranite', body: 'done', replyTo: incoming.message.msgId });
    expect(store.unreadDmCount('Murphy-Ranite')).toBe(0);
  });

  it('does not acknowledge a group message id via replyTo', () => {
    const group = operations.postMessage('Atreus-Ranite', { recipient: 'group', body: 'announce' });
    if (group.duplicate) throw new Error('unreachable');
    // Replying to a group id is a no-op for the inbox (ackDms only touches own DMs).
    operations.postMessage('Murphy-Ranite', { recipient: 'group', body: 'ack', replyTo: group.message.msgId });
    expect(store.unreadDmCount('Murphy-Ranite')).toBe(0);
  });
});
