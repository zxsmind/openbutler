import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isTailnetAddress, findTailnetAddress, parseJoinTarget, TEAM_DEFAULT_PORT } from '../src/team/tailnet.js';
import { fingerprintOf, hashTicket, makeInviteCode, makeTicket, validateMemberName } from '../src/team/service.js';

describe('tailnet address handling', () => {
  it('accepts only the CGNAT range Tailscale uses', () => {
    expect(isTailnetAddress('100.64.0.1')).toBe(true);
    expect(isTailnetAddress('100.127.255.254')).toBe(true);
    expect(isTailnetAddress('100.63.255.255')).toBe(false);
    expect(isTailnetAddress('100.128.0.1')).toBe(false);
    expect(isTailnetAddress('192.168.1.5')).toBe(false);
    expect(isTailnetAddress('10.0.0.1')).toBe(false);
    expect(isTailnetAddress('not-an-ip')).toBe(false);
  });

  it('finds the tailnet address among interfaces and ignores internal and non-tailnet ones', () => {
    const found = findTailnetAddress(() => ({
      lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true } as never],
      eth0: [{ address: '192.168.1.20', family: 'IPv4', internal: false } as never],
      tailscale0: [{ address: '100.101.102.103', family: 'IPv4', internal: false } as never],
    }));
    expect(found).toBe('100.101.102.103');
    expect(findTailnetAddress(() => ({ eth0: [{ address: '192.168.1.20', family: 'IPv4', internal: false } as never] }))).toBeNull();
  });

  it('parses a bare tailnet IP, an IP with port, and a MagicDNS name', () => {
    expect(parseJoinTarget('100.64.0.1')).toEqual({ host: '100.64.0.1', port: TEAM_DEFAULT_PORT });
    expect(parseJoinTarget('100.64.0.1:1234')).toEqual({ host: '100.64.0.1', port: 1234 });
    expect(parseJoinTarget('server.tail-ahead.ts.net:47821')).toEqual({ host: 'server.tail-ahead.ts.net', port: 47821 });
    expect(parseJoinTarget('  server.tail-ahead.ts.net  ')).toEqual({ host: 'server.tail-ahead.ts.net', port: TEAM_DEFAULT_PORT });
  });

  it('refuses URLs, userinfo, paths, non-tailnet literals, and bad ports', () => {
    expect(() => parseJoinTarget('http://100.64.0.1:1')).toThrow('not a URL');
    expect(() => parseJoinTarget('user@100.64.0.1')).toThrow();
    expect(() => parseJoinTarget('100.64.0.1/path')).toThrow();
    expect(() => parseJoinTarget('8.8.8.8')).toThrow('outside the tailnet');
    expect(() => parseJoinTarget('192.168.0.1:9999')).toThrow('outside the tailnet');
    expect(() => parseJoinTarget('100.64.0.1:0')).toThrow('out of range');
    expect(() => parseJoinTarget('')).toThrow();
  });
});

describe('member names', () => {
  it('accepts safe names and refuses the rest', () => {
    expect(validateMemberName('Atreus-Ranite')).toBe('Atreus-Ranite');
    expect(validateMemberName('  Murphy_2  ')).toBe('Murphy_2');
    expect(() => validateMemberName('a b')).toThrow();
    expect(() => validateMemberName('-lead')).toThrow();
    expect(() => validateMemberName('')).toThrow();
    expect(() => validateMemberName('x'.repeat(65))).toThrow();
  });
});

describe('team secrets', () => {
  it('makes single-use-looking codes and stable fingerprints', () => {
    expect(makeInviteCode(() => 'kartal')).toMatch(/^kartal-[0-9]{4}$/);
    const id = 'a'.repeat(32);
    expect(fingerprintOf(id)).toBe(fingerprintOf(id));
    expect(fingerprintOf(id)).toMatch(/^[0-9A-F]{4}:[0-9A-F]{4}:[0-9A-F]{4}$/);
    expect(fingerprintOf(id)).not.toBe(fingerprintOf('b'.repeat(32)));
  });

  it('hashes tickets deterministically without storing the raw value', () => {
    const ticket = makeTicket();
    expect(ticket).toMatch(/^rt_[0-9a-f]{48}$/);
    expect(hashTicket(ticket)).toBe(hashTicket(ticket));
    expect(hashTicket(ticket)).not.toContain(ticket);
  });
});

let dataDir: string;
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'ranite-team-store-'));
});
afterEach(() => {
  delete process.env.RANITE_DATA_DIR;
});

describe('TeamStore', () => {
  it('initializes one hub, refuses a second, and retires removed names', async () => {
    const { TeamStore } = await import('../src/team/store.js');
    const store = new TeamStore(join(dataDir, 'team.db'));
    const now = 1_000;
    store.initHub('hub-id', 'team-id', 'MyTeam', 'Atreus-Ranite', now);
    expect(store.isInitialized()).toBe(true);
    expect(() => store.initHub('other', 'team-2', 'X', 'Y', now)).toThrow('already initialized');
    expect(store.nameTaken('atreus-ranite')).toBe(true);

    store.createInvite('kartal-1234', 60_000, now);
    expect(store.getInvite('kartal-1234', now)?.code).toBe('kartal-1234');
    expect(store.consumeInvite('kartal-1234', 'Murphy-Ranite', now)).toBe(true);
    expect(store.consumeInvite('kartal-1234', 'Someone', now)).toBe(false);
    expect(store.getInvite('kartal-1234', now)).toBeNull();

    store.createInvite('expired-1', 1, now);
    expect(store.getInvite('expired-1', now + 5)).toBeNull();

    store.close();
  });

  it('takes a join from pending to approved, reveals the ticket once, then forgets it', async () => {
    const { TeamStore } = await import('../src/team/store.js');
    const store = new TeamStore(join(dataDir, 'team.db'));
    const now = 5_000;
    store.initHub('hub-id', 'team-id', 'MyTeam', 'Atreus-Ranite', now);
    store.createJoinRequest('jr_1', 'Murphy-Ranite', 'kartal-1234', now);
    expect(store.listPendingJoins()).toHaveLength(1);

    const ticket = makeTicket();
    expect(store.decideJoin('jr_1', true, ticket, hashTicket(ticket), now)).toBe(true);
    expect(store.decideJoin('jr_1', true, ticket, hashTicket(ticket), now)).toBe(false);
    expect(store.getJoinRequest('jr_1')?.status).toBe('approved');
    // Pickup is idempotent: the ticket is returned until confirmed or it expires.
    expect(store.peekTicket('jr_1', now, 60_000)).toBe(ticket);
    expect(store.peekTicket('jr_1', now, 60_000)).toBe(ticket);
    store.confirmTicket('jr_1');
    expect(store.peekTicket('jr_1', now, 60_000)).toBeNull();
    expect(store.findByTicketHash(hashTicket(ticket))?.name).toBe('Murphy-Ranite');
    store.close();
  });

  it('expires an unconfirmed ticket after the pickup TTL', async () => {
    const { TeamStore } = await import('../src/team/store.js');
    const store = new TeamStore(join(dataDir, 'team.db'));
    const now = 1_000;
    store.initHub('hub-id', 'team-id', 'MyTeam', 'Atreus-Ranite', now);
    store.createJoinRequest('jr_1', 'Murphy-Ranite', 'kartal-1234', now);
    const ticket = makeTicket();
    store.decideJoin('jr_1', true, ticket, hashTicket(ticket), now);
    expect(store.peekTicket('jr_1', now + 60_001, 60_000)).toBeNull();
    store.close();
  });

  it('refuses a duplicate name at approval and revokes tickets on removal', async () => {
    const { TeamStore } = await import('../src/team/store.js');
    const store = new TeamStore(join(dataDir, 'team.db'));
    const now = 9_000;
    store.initHub('hub-id', 'team-id', 'MyTeam', 'Atreus-Ranite', now);
    store.createJoinRequest('jr_1', 'Murphy-Ranite', 'kartal-1234', now);
    const ticket = makeTicket();
    store.decideJoin('jr_1', true, ticket, hashTicket(ticket), now);
    store.confirmTicket('jr_1');

    // A second Murphy cannot slip in even if a request exists.
    store.createJoinRequest('jr_2', 'murphy-ranite', 'kartal-5678', now);
    expect(store.decideJoin('jr_2', true, makeTicket(), hashTicket('x'), now)).toBe(false);

    expect(store.removeMember('Murphy-Ranite', now)).toBe('removed');
    expect(store.findByTicketHash(hashTicket(ticket))).toBeNull();
    expect(store.removeMember('Murphy-Ranite', now)).toBe('missing');
    expect(store.removeMember('Atreus-Ranite', now)).toBe('hub');
    // Removed names stay retired: they cannot be reused.
    expect(store.nameTaken('murphy-ranite')).toBe(true);
    store.close();
  });

  it('summarizes members with presence and last activity', async () => {
    const { TeamStore } = await import('../src/team/store.js');
    const store = new TeamStore(join(dataDir, 'team.db'));
    const now = 10_000;
    store.initHub('hub-id', 'team-id', 'MyTeam', 'Atreus-Ranite', now);
    store.createJoinRequest('jr_m', 'Murphy-Ranite', 'kartal-1', now);
    const ticket = makeTicket();
    store.decideJoin('jr_m', true, ticket, hashTicket(ticket), now);
    store.confirmTicket('jr_m');

    store.postMessage({ msgId: 'm_1', sender: 'Murphy-Ranite', recipient: 'group', body: 'hi', createdAt: now + 5 });
    store.appendMemory({ topic: 'decisions', author: 'Murphy-Ranite', body: 'x', createdAt: now + 6 });
    store.touchMember('Murphy-Ranite', now + 7);

    const summaries = store.memberSummaries(now + 8, 15_000);
    const murphy = summaries.find((entry) => entry.name === 'Murphy-Ranite')!;
    const hub = summaries.find((entry) => entry.name === 'Atreus-Ranite')!;
    expect(murphy.online).toBe(true);
    expect(murphy.lastMessageAt).toBe(now + 5);
    expect(murphy.lastMessageTo).toBe('group');
    expect(murphy.lastMemoryAt).toBe(now + 6);
    // The hub is always online; it has never messaged or written memory.
    expect(hub.online).toBe(true);
    expect(hub.lastMessageAt).toBeNull();
    // Long after the window, a quiet member falls offline but the hub stays online.
    const later = store.memberSummaries(now + 60_000, 15_000);
    expect(later.find((entry) => entry.name === 'Murphy-Ranite')?.online).toBe(false);
    expect(later.find((entry) => entry.name === 'Atreus-Ranite')?.online).toBe(true);
    store.close();
  });
});
