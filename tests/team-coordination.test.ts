import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TeamStore } from '../src/team/store.js';
import { TeamCoordination, type PeerProfile, type PeerWork } from '../src/team/coordination.js';
import { localChannel, remoteChannel, type TeamChannel } from '../src/team/session.js';
import { startTeamServer, type StartedTeamServer } from '../src/team/server.js';
import { hashTicket } from '../src/team/service.js';

let directory: string;
let store: TeamStore;
let server: StartedTeamServer;
let hub: TeamChannel;
let peer: TeamChannel;
let outsider: TeamChannel;

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'ranite-peer-contract-'));
  store = new TeamStore(join(directory, 'team.db'));
  store.initHub('hub-id', 'team-id', 'Team', 'Hub', Date.now());
  for (const name of ['Peer', 'Other']) {
    store.createJoinRequest(`jr_${name}`, name, 'invite', Date.now());
    store.decideJoin(`jr_${name}`, true, `ticket-${name}`, hashTicket(`ticket-${name}`), Date.now());
  }
  server = await startTeamServer({ store, bindAddress: '127.0.0.1', port: 0, allowLoopback: true });
  const target = { host: '127.0.0.1', port: Number(new URL(server.url).port) };
  hub = localChannel(store, 'Hub');
  peer = remoteChannel(target, 'ticket-Peer', 'Peer');
  outsider = remoteChannel(target, 'ticket-Other', 'Other');
});

afterEach(async () => {
  await server.close();
  store.close();
  if (dirname(resolve(directory)) !== resolve(tmpdir())) throw new Error('Unsafe fixture cleanup');
  rmSync(directory, { recursive: true, force: true });
});

async function propose(id = 'request-1'): Promise<PeerWork> {
  return (await hub.work({
    action: 'propose',
    id,
    peer: 'peer',
    terms: 'Investigate the service read-only and return evidence.',
  })) as PeerWork;
}

describe('peer identity and capability provenance', () => {
  it('exposes one self-authored profile through both channels and refuses another member overwrite', async () => {
    expect(await peer.profile({ action: 'read' })).toBeNull();
    const profile = (await peer.profile({
      action: 'update',
      expectedRevision: 0,
      description: 'I investigate service failures; design work is outside my experience.',
    })) as PeerProfile;
    expect(await hub.profile({ action: 'read', member: 'peer' })).toEqual(profile);
    expect((await hub.status()).members.find((member) => member.name === 'Peer')?.profile).toEqual(profile);
    expect((await peer.status()).members.find((member) => member.name === 'Peer')?.profile).toEqual(profile);
    await expect(hub.profile({ action: 'update', member: 'Peer', expectedRevision: 1, description: 'Overwritten' })).rejects.toThrow(
      'own profile',
    );
    await expect(peer.profile({ action: 'update', member: 'Hub', expectedRevision: 0, description: 'Overwritten' })).rejects.toThrow(
      'own profile',
    );
  });

  it('makes an identical profile retry safe and rejects a stale overwrite', async () => {
    const input = { action: 'update', expectedRevision: 0, description: 'Operations experience.' };
    const first = await peer.profile(input);
    expect(await peer.profile(input)).toEqual(first);
    await expect(peer.profile({ ...input, description: 'Different text.' })).rejects.toThrow('changed');
    expect(((await peer.profile({ action: 'read' })) as PeerProfile).description).toBe(input.description);
  });

  it('keeps host reports separate from self-description and timestamps them at the hub', async () => {
    await peer.profile({ action: 'update', expectedRevision: 0, description: 'Experienced with documents.' });
    await peer.reportCapabilities({
      platform: 'linux',
      custodianBusy: true,
      mcpServers: [{ name: 'documents', toolCount: 3 }],
      mcpTools: ['documents/read'],
    });
    const view = (await hub.status()).members.find((member) => member.name === 'Peer')!;
    expect(view.capabilities).toMatchObject({ platform: 'linux', custodianBusy: true, mcpServers: [{ name: 'documents', toolCount: 3 }] });
    expect(view.capabilities!.observedAt).toBeGreaterThan(0);
    await peer.profile({ action: 'update', expectedRevision: 1, description: 'Updated experience.' });
    expect((await peer.status()).members.find((member) => member.name === 'Peer')?.capabilities).toEqual(view.capabilities);
    expect((await peer.status()).members.find((member) => member.name === 'Other')?.capabilities).toBeNull();
  });
});

describe('independent peer agreements', () => {
  it('records an agreement from proposal to completion with evidence', async () => {
    const proposed = await propose();
    expect(proposed).toMatchObject({ requester: 'Hub', assignee: 'Peer', state: 'proposed', revision: 1 });
    await expect(hub.work({ action: 'accept', id: proposed.id, expectedRevision: 1, note: 'Assign it.' })).rejects.toThrow('pending terms');
    await peer.work({ action: 'accept', id: proposed.id, expectedRevision: 1, note: 'Accepted, read-only.' });
    expect((await hub.status()).members.find((member) => member.name === 'Peer')?.activeWorkCount).toBe(1);
    const done = (await peer.work({
      action: 'complete',
      id: proposed.id,
      expectedRevision: 2,
      note: 'Log event 42 confirms the upstream timeout; no changes were made.',
    })) as PeerWork;
    expect(done).toMatchObject({
      state: 'completed',
      revision: 3,
      result: 'Log event 42 confirms the upstream timeout; no changes were made.',
    });
    expect(await hub.work({ action: 'list' })).toEqual([]);
    expect(await hub.work({ action: 'list', includeClosed: true })).toEqual([done]);
    expect((await hub.status()).members.find((member) => member.name === 'Peer')?.activeWorkCount).toBe(0);
  });

  it('does not equate reading a notification with acceptance or completion', async () => {
    const proposed = await propose();
    expect((await peer.readInbox(20)).messages).toHaveLength(1);
    expect((await peer.inbox()).count).toBe(1);
    await peer.ack((await peer.inbox()).messages.map((message) => message.msgId));
    expect((await peer.inbox()).count).toBe(0);
    expect(await peer.work({ action: 'read', id: proposed.id })).toEqual(proposed);
    expect(await peer.work({ action: 'list' })).toEqual([proposed]);
  });

  it('deduplicates proposal and transition retries without duplicating wake messages', async () => {
    const first = await propose();
    expect(await propose()).toEqual(first);
    expect((await peer.inbox()).count).toBe(1);
    const accept = { action: 'accept', id: first.id, expectedRevision: 1, note: 'Accepted read-only.' };
    const accepted = await peer.work(accept);
    expect(await peer.work(accept)).toEqual(accepted);
    expect((await hub.inbox()).count).toBe(1);
    await expect(peer.work({ ...accept, note: 'Different stale action.' })).rejects.toThrow('changed');
    await expect(hub.work({ action: 'propose', id: first.id, peer: 'Peer', terms: 'Different scope' })).rejects.toThrow('already in use');
  });

  it('restricts records and execution changes to their participants and roles', async () => {
    const work = await propose();
    expect(await outsider.work({ action: 'list' })).toEqual([]);
    await expect(outsider.work({ action: 'read', id: work.id })).rejects.toThrow('accessible');
    await peer.work({ action: 'accept', id: work.id, expectedRevision: 1, note: 'Accepted.' });
    await expect(hub.work({ action: 'complete', id: work.id, expectedRevision: 2, note: 'Pretend done.' })).rejects.toThrow('assignee');
    await expect(peer.work({ action: 'cancel', id: work.id, expectedRevision: 2, note: 'Cannot.' })).rejects.toThrow('requester');
    await hub.work({ action: 'cancel', id: work.id, expectedRevision: 2, note: 'Owner changed the request.' });
    await expect(peer.work({ action: 'complete', id: work.id, expectedRevision: 3, note: 'Continue.' })).rejects.toThrow('closed');
  });

  it('allows clarification and refusal without inventing acceptance', async () => {
    const work = await propose();
    await peer.work({ action: 'note', id: work.id, expectedRevision: 1, note: 'Which service do you mean?' });
    expect(((await hub.work({ action: 'read', id: work.id })) as PeerWork).state).toBe('proposed');
    await peer.work({ action: 'reject', id: work.id, expectedRevision: 2, note: 'I do not have access.' });
    expect(((await hub.work({ action: 'read', id: work.id })) as PeerWork).state).toBe('rejected');
  });

  it('rolls back a new agreement if its notification cannot be persisted', async () => {
    store.postMessage({ msgId: 'work_collision_1', sender: 'Hub', recipient: 'Peer', body: 'existing', createdAt: Date.now() });
    expect(() =>
      new TeamCoordination(store).work('Hub', { action: 'propose', id: 'collision', peer: 'Peer', terms: 'Inspect.' }),
    ).toThrow();
    expect(store.peerWork('collision')).toBeNull();
  });

  it('retains agreements and the single profile across database reopen', async () => {
    const work = await propose();
    const profile = await peer.profile({ action: 'update', expectedRevision: 0, description: 'Persistent description.' });
    const reopened = new TeamStore(join(directory, 'team.db'));
    try {
      expect(reopened.peerWork(work.id)).toEqual(work);
      expect(reopened.peerProfile('Peer')).toEqual(profile);
    } finally {
      reopened.close();
    }
  });

  it('pages open agreements so older dependencies remain discoverable', async () => {
    await propose('first');
    await propose('second');
    await propose('third');
    const firstPage = (await peer.work({ action: 'list', limit: 1, offset: 0 })) as PeerWork[];
    const secondPage = (await peer.work({ action: 'list', limit: 1, offset: 1 })) as PeerWork[];
    const thirdPage = (await peer.work({ action: 'list', limit: 1, offset: 2 })) as PeerWork[];
    expect(new Set([...firstPage, ...secondPage, ...thirdPage].map((work) => work.id))).toEqual(new Set(['first', 'second', 'third']));
  });
});

describe('negotiated terms', () => {
  it('requires explicit acceptance by the other party before executing countered terms', async () => {
    const work = await propose('negotiation');
    const counter = {
      action: 'counter',
      id: work.id,
      expectedRevision: 1,
      terms: 'Read logs only; return a bounded report.',
      note: 'The original scope is too broad.',
    };
    const revised = (await peer.work(counter)) as PeerWork;
    expect(revised).toMatchObject({ state: 'countered', terms: counter.terms, termsAuthor: 'Peer', revision: 2 });
    expect(await peer.work(counter)).toEqual(revised);
    await expect(peer.work({ action: 'accept', id: work.id, expectedRevision: 2, note: 'self accept' })).rejects.toThrow(
      'other participant',
    );
    await expect(peer.work({ action: 'complete', id: work.id, expectedRevision: 2, note: 'premature' })).rejects.toThrow('accepted');
    const accepted = (await hub.work({
      action: 'accept',
      id: work.id,
      expectedRevision: 2,
      note: 'Replacement terms accepted.',
    })) as PeerWork;
    expect(accepted).toMatchObject({ state: 'accepted', terms: counter.terms, revision: 3 });
    const complete = (await peer.work({
      action: 'complete',
      id: work.id,
      expectedRevision: 3,
      note: 'Log event 1 and report attached.',
    })) as PeerWork;
    expect(complete.state).toBe('completed');
  });
});

it('keeps durable working and blocked states under assignee ownership', async () => {
  const work = await propose('execution-lifecycle');
  await peer.work({ action: 'accept', id: work.id, expectedRevision: 1, note: 'Accepted.' });
  await expect(hub.work({ action: 'start', id: work.id, expectedRevision: 2, note: 'Not my execution.' })).rejects.toThrow('assignee');
  for (const [action, expectedRevision, expectedState] of [
    ['start', 2, 'working'],
    ['block', 3, 'blocked'],
    ['resume', 4, 'working'],
  ] as const) {
    const changed = (await peer.work({ action, id: work.id, expectedRevision, note: `Evidence for ${action}.` })) as PeerWork;
    expect(changed.state).toBe(expectedState);
    expect((await hub.status()).members.find((member) => member.name === 'Peer')?.activeWorkCount).toBe(1);
  }
  await peer.work({ action: 'complete', id: work.id, expectedRevision: 5, note: 'Verified output delivered.' });
  expect((await hub.status()).members.find((member) => member.name === 'Peer')?.activeWorkCount).toBe(0);
});
