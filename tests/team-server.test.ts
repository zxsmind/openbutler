import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fetchHubFingerprint, fetchHubStatus, pollJoin, postJoin, postLeave } from '../src/team/client.js';
import { startTeamServer, type StartedTeamServer } from '../src/team/server.js';
import { hashTicket, makeTicket } from '../src/team/service.js';
import { TeamStore } from '../src/team/store.js';
import type { JoinTarget } from '../src/team/tailnet.js';

let dataDir: string;
let store: TeamStore;
let server: StartedTeamServer | null = null;
let target: JoinTarget;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'ranite-team-server-'));
  store = new TeamStore(join(dataDir, 'team.db'));
  store.initHub('hub-id', 'team-id', 'MyTeam', 'Atreus-Ranite', Date.now());
});

afterEach(async () => {
  await server?.close();
  server = null;
  store.close();
});

async function startOnEphemeralPort(): Promise<void> {
  // Port 0 asks the OS for a free port; the client still talks over loopback.
  const started = await startTeamServer({ store, bindAddress: '127.0.0.1', port: 0, allowLoopback: true });
  const port = Number(new URL(started.url).port);
  target = { host: '127.0.0.1', port };
  server = started;
}

describe('team hub server', () => {
  it('refuses to bind anything but the tailnet (unless loopback is explicitly allowed)', () => {
    expect(() => startTeamServer({ store, bindAddress: '0.0.0.0', port: 1234 })).toThrow('not a tailnet address');
    expect(() => startTeamServer({ store, bindAddress: '203.0.113.5', port: 1234 })).toThrow('not a tailnet address');
    expect(() => startTeamServer({ store, bindAddress: '127.0.0.1', port: 1234 })).toThrow('not a tailnet address');
  });

  it('shows a stable fingerprint and runs a full join: invite → request → approve → ticket', async () => {
    await startOnEphemeralPort();
    const hub = await fetchHubFingerprint(target);
    expect(hub.team).toBe('MyTeam');
    expect(hub.fingerprint).toMatch(/^[0-9A-F]{4}:[0-9A-F]{4}:[0-9A-F]{4}$/);

    store.createInvite('kartal-1234', 60_000, Date.now());
    const requestId = await postJoin(target, 'kartal-1234', 'Murphy-Ranite');
    expect(await pollJoin(target, requestId)).toEqual({ status: 'pending' });
    expect(store.listPendingJoins().map((entry) => entry.name)).toEqual(['Murphy-Ranite']);

    const ticket = makeTicket();
    store.decideJoin(requestId, true, ticket, hashTicket(ticket), Date.now());
    const approved = await pollJoin(target, requestId);
    expect(approved).toMatchObject({ status: 'approved', memberName: 'Murphy-Ranite', team: 'MyTeam' });
    expect(approved.status === 'approved' && approved.ticket).toBe(ticket);
    // The ticket is a one-time reveal.
    expect(store.revealTicket(requestId)).toBeNull();

    const status = await fetchHubStatus(target, ticket);
    expect(status.you).toBe('Murphy-Ranite');
    expect(status.members.map((entry) => entry.name)).toEqual(['Atreus-Ranite', 'Murphy-Ranite']);

    await postLeave(target, ticket);
    expect(store.findByTicketHash(hashTicket(ticket))).toBeNull();
  });

  it('rejects unknown, used, and expired codes with one message, and duplicate names', async () => {
    await startOnEphemeralPort();
    await expect(postJoin(target, 'nope-0000', 'Murphy-Ranite')).rejects.toThrow('Invite code is invalid');

    store.createInvite('kartal-1234', 60_000, Date.now());
    await postJoin(target, 'kartal-1234', 'Murphy-Ranite');
    // Same code again: single use.
    await expect(postJoin(target, 'kartal-1234', 'Other-Ranite')).rejects.toThrow('Invite code is invalid');

    // Expired code.
    store.createInvite('expired-1', 1, Date.now() - 10);
    await expect(postJoin(target, 'expired-1', 'Other-Ranite')).rejects.toThrow('Invite code is invalid');

    // A taken name is refused before the request is recorded.
    store.createInvite('kartal-5678', 60_000, Date.now());
    await expect(postJoin(target, 'kartal-5678', 'Atreus-Ranite')).rejects.toThrow('already taken');
  });

  it('requires a valid ticket for status and leave', async () => {
    await startOnEphemeralPort();
    await expect(fetchHubStatus(target, 'rt_deadbeef')).rejects.toThrow('valid member ticket');
    await expect(postLeave(target, 'rt_deadbeef')).rejects.toThrow('valid member ticket');
  });

  it('denies a request so the joiner learns without a ticket', async () => {
    await startOnEphemeralPort();
    store.createInvite('kartal-1234', 60_000, Date.now());
    const requestId = await postJoin(target, 'kartal-1234', 'Murphy-Ranite');
    store.decideJoin(requestId, false, null, null, Date.now());
    expect(await pollJoin(target, requestId)).toEqual({ status: 'denied' });
  });

  it('brakes repeated failed joins from one address', async () => {
    let clock = 1_000_000;
    const started = await startTeamServer({ store, bindAddress: '127.0.0.1', port: 0, allowLoopback: true, now: () => clock });
    target = { host: '127.0.0.1', port: Number(new URL(started.url).port) };
    server = started;

    await expect(postJoin(target, 'nope-0001', 'Murphy-Ranite')).rejects.toThrow('Invite code is invalid');
    await expect(postJoin(target, 'nope-0002', 'Murphy-Ranite')).rejects.toThrow('Invite code is invalid');
    await expect(postJoin(target, 'nope-0003', 'Murphy-Ranite')).rejects.toThrow('Invite code is invalid');
    // Fourth attempt is refused outright, even with a valid code.
    store.createInvite('kartal-9999', 600_000, clock);
    await expect(postJoin(target, 'kartal-9999', 'Murphy-Ranite')).rejects.toThrow('Too many failed join attempts');

    // After the block window the brake releases.
    clock += 5 * 60_000 + 1;
    const requestId = await postJoin(target, 'kartal-9999', 'Murphy-Ranite');
    expect(await pollJoin(target, requestId)).toEqual({ status: 'pending' });
  });

  it('reports presence: the hub is always online, members by recency', async () => {
    let clock = Date.now();
    const started = await startTeamServer({ store, bindAddress: '127.0.0.1', port: 0, allowLoopback: true, now: () => clock });
    target = { host: '127.0.0.1', port: Number(new URL(started.url).port) };
    server = started;

    store.createInvite('kartal-1234', 60_000, clock);
    const requestId = await postJoin(target, 'kartal-1234', 'Murphy-Ranite');
    const ticket = makeTicket();
    store.decideJoin(requestId, true, ticket, hashTicket(ticket), clock);
    store.revealTicket(requestId);
    // A second member who never polls.
    store.createJoinRequest('jr_z', 'Zephyr-Ranite', 'kartal-5678', clock);
    const zephyrTicket = makeTicket();
    store.decideJoin('jr_z', true, zephyrTicket, hashTicket(zephyrTicket), clock);

    const live = await fetchHubStatus(target, ticket);
    expect(live.members.find((entry) => entry.name === 'Murphy-Ranite')?.online).toBe(true);
    // The hub answers this query, so it is online by definition.
    expect(live.members.find((entry) => entry.name === 'Atreus-Ranite')?.online).toBe(true);
    expect(live.memberCount).toBe(3);

    // After the poll window, a member that has not polled falls offline.
    clock += 60_000;
    const later = await fetchHubStatus(target, ticket);
    expect(later.members.find((entry) => entry.name === 'Zephyr-Ranite')?.online).toBe(false);
    expect(later.members.find((entry) => entry.name === 'Atreus-Ranite')?.online).toBe(true);
  });
});
