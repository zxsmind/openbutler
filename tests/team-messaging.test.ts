import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ackInbox, fetchGroup, fetchInbox, postMessage, readGroup, setGroupCursor } from '../src/team/client.js';
import { startTeamServer, type StartedTeamServer } from '../src/team/server.js';
import { hashTicket, makeTicket } from '../src/team/service.js';
import { localChannel, remoteChannel } from '../src/team/session.js';
import { TeamStore } from '../src/team/store.js';
import type { JoinTarget } from '../src/team/tailnet.js';

let dataDir: string;
let store: TeamStore;
let server: StartedTeamServer | null = null;
let target: JoinTarget;
let murphyTicket: string;

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'ranite-team-msg-'));
  store = new TeamStore(join(dataDir, 'team.db'));
  const now = Date.now();
  store.initHub('hub-id', 'team-id', 'MyTeam', 'Atreus-Ranite', now);
  store.createJoinRequest('jr_m', 'Murphy-Ranite', 'kartal-2222', now);
  murphyTicket = makeTicket();
  store.decideJoin('jr_m', true, murphyTicket, hashTicket(murphyTicket), now);
  store.confirmTicket('jr_m');
  const started = await startTeamServer({ store, bindAddress: '127.0.0.1', port: 0, allowLoopback: true });
  target = { host: '127.0.0.1', port: Number(new URL(started.url).port) };
  server = started;
});

afterEach(async () => {
  await server?.close();
  server = null;
  store.close();
});

describe('team messaging over the hub', () => {
  it('orders group messages by a single hub sequence and time', async () => {
    const first = await postMessage(target, murphyTicket, { recipient: 'group', body: 'hello team' });
    const second = await postMessage(target, murphyTicket, { recipient: 'group', body: 'second' });
    expect(second.seq! > first.seq!).toBe(true);
    const group = await fetchGroup(target, murphyTicket, 0);
    expect(group.messages.map((message) => message.body)).toEqual(['hello team', 'second']);
    expect(group.messages.every((message) => message.sender === 'Murphy-Ranite')).toBe(true);
    expect(group.latestSeq).toBe(second.seq);
  });

  it('advances the group cursor so only new messages come back', async () => {
    const first = await postMessage(target, murphyTicket, { recipient: 'group', body: 'one' });
    await setGroupCursor(target, murphyTicket, first.seq!);
    await postMessage(target, murphyTicket, { recipient: 'group', body: 'two' });
    const group = await fetchGroup(target, murphyTicket, first.seq!);
    expect(group.messages.map((message) => message.body)).toEqual(['two']);
  });

  it('reads the group incrementally and advances the stored cursor', async () => {
    await postMessage(target, murphyTicket, { recipient: 'group', body: 'first' });
    const read = await readGroup(target, murphyTicket, 50);
    expect(read.messages.map((message) => message.body)).toEqual(['first']);
    // A second read returns nothing new, proving the cursor advanced.
    const again = await readGroup(target, murphyTicket, 50);
    expect(again.messages).toHaveLength(0);
    await postMessage(target, murphyTicket, { recipient: 'group', body: 'second' });
    const third = await readGroup(target, murphyTicket, 50);
    expect(third.messages.map((message) => message.body)).toEqual(['second']);
  });

  it('holds DMs until the recipient acknowledges, and never delivers them to the group', async () => {
    const hub = localChannel(store, 'Atreus-Ranite');
    await hub.send('Murphy-Ranite', 'private ping');
    const inbox = await fetchInbox(target, murphyTicket);
    expect(inbox.count).toBe(1);
    expect(inbox.messages[0]?.body).toBe('private ping');

    const group = await fetchGroup(target, murphyTicket, 0);
    expect(group.messages).toHaveLength(0);

    const ack = await ackInbox(target, murphyTicket, [inbox.messages[0]!.msgId]);
    expect(ack).toEqual({ acknowledged: 1, remaining: 0 });
    expect((await fetchInbox(target, murphyTicket)).count).toBe(0);
  });

  it('rejects a message to an unknown member and an empty body', async () => {
    await expect(postMessage(target, murphyTicket, { recipient: 'Nobody-Ranite', body: 'hi' })).rejects.toThrow('No member named');
    await expect(postMessage(target, murphyTicket, { recipient: 'group', body: '   ' })).rejects.toThrow('cannot be empty');
  });

  it('is idempotent: the same msgId is not stored twice', async () => {
    const first = await postMessage(target, murphyTicket, { recipient: 'group', body: 'once', msgId: 'm_fixed' });
    const again = await postMessage(target, murphyTicket, { recipient: 'group', body: 'once', msgId: 'm_fixed' });
    expect(again.duplicate).toBe(true);
    const group = await fetchGroup(target, murphyTicket, 0);
    expect(group.messages.filter((message) => message.msgId === 'm_fixed')).toHaveLength(1);
    void first;
  });
});

describe('team channels', () => {
  it('behaves the same locally (hub) and remotely (member)', async () => {
    const hub = localChannel(store, 'Atreus-Ranite');
    const member = remoteChannel(target, murphyTicket, 'Murphy-Ranite');

    await member.send('group', 'from murphy');
    const hubView = await hub.group(0);
    expect(hubView.messages.map((message) => message.body)).toEqual(['from murphy']);

    await hub.send('Murphy-Ranite', 'from hub');
    const memberInbox = await member.inbox();
    expect(memberInbox.messages.map((message) => message.body)).toEqual(['from hub']);
    await member.ack(memberInbox.messages.map((message) => message.msgId));
    expect((await member.inbox()).count).toBe(0);
  });
});
