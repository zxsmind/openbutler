import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fetchTeamMemory, postTeamMemory } from '../src/team/client.js';
import { materializeTeamMemory, renderTeamMemoryFile } from '../src/team/memory-mirror.js';
import { startTeamServer, type StartedTeamServer } from '../src/team/server.js';
import { hashTicket, makeTicket } from '../src/team/service.js';
import { localChannel, readAllTeamMemory, remoteChannel, type TeamChannel } from '../src/team/session.js';
import { TeamStore } from '../src/team/store.js';
import type { JoinTarget } from '../src/team/tailnet.js';

let dataDir: string;
let store: TeamStore;
let server: StartedTeamServer | null = null;
let target: JoinTarget;
let murphyTicket: string;

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'openbutler-team-mem-'));
  process.env.OPENBUTLER_DATA_DIR = dataDir;
  store = new TeamStore(join(dataDir, 'team.db'));
  const now = Date.now();
  store.initHub('hub-id', 'team-id', 'MyTeam', 'Atreus-OpenButler', now);
  store.createJoinRequest('jr_m', 'Murphy-OpenButler', 'kartal-2222', now);
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
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.OPENBUTLER_DATA_DIR;
});

describe('shared team memory over the hub', () => {
  it('appends signed entries and reads them after a sequence', async () => {
    const first = await postTeamMemory(target, murphyTicket, 'decisions', 'We deploy on weekdays only.');
    const second = await postTeamMemory(target, murphyTicket, 'shared', 'The staging URL is internal.');
    expect(second.seq).toBeGreaterThan(first.seq);

    const all = await fetchTeamMemory(target, murphyTicket, 0);
    expect(all.latestSeq).toBe(second.seq);
    expect(all.entries.map((entry) => entry.body)).toEqual(['We deploy on weekdays only.', 'The staging URL is internal.']);
    expect(all.entries.every((entry) => entry.author === 'Murphy-OpenButler')).toBe(true);

    const afterFirst = await fetchTeamMemory(target, murphyTicket, first.seq);
    expect(afterFirst.entries.map((entry) => entry.body)).toEqual(['The staging URL is internal.']);
  });

  it('rejects an empty entry and an unknown topic', async () => {
    await expect(postTeamMemory(target, murphyTicket, 'decisions', '   ')).rejects.toThrow('cannot be empty');
    await expect(postTeamMemory(target, murphyTicket, 'shared', 'x'.repeat(9000))).rejects.toThrow('limited to');
  });

  it('behaves the same locally (hub) and remotely (member)', async () => {
    const hub = localChannel(store, 'Atreus-OpenButler');
    const member = remoteChannel(target, murphyTicket, 'Murphy-OpenButler');
    await hub.remember('decisions', 'The hub wrote this.');
    await member.remember('decisions', 'The member wrote this.');
    const view = await member.memory(0);
    expect(view.entries.map((entry) => entry.author)).toEqual(['Atreus-OpenButler', 'Murphy-OpenButler']);
  });
});

describe('team memory mirror', () => {
  it('renders a valid memory document, one signed bullet per entry', () => {
    const content = renderTeamMemoryFile(
      'decisions',
      [
        { seq: 1, topic: 'decisions', author: 'Atreus-OpenButler', body: 'Deploy on weekdays.', createdAt: Date.UTC(2026, 9, 14) },
        { seq: 2, topic: 'shared', author: 'Murphy-OpenButler', body: 'ignored here', createdAt: Date.UTC(2026, 9, 15) },
      ],
      '2026-10-16',
    );
    expect(content).toContain('title: Team decisions');
    expect(content).toContain('type: reference');
    expect(content).toContain('- [2026-10-14 · Atreus-OpenButler] Deploy on weekdays.');
    // The other topic's entry is not in this file.
    expect(content).not.toContain('ignored here');
  });

  it('materializes both topic files under the team folder on disk', () => {
    materializeTeamMemory(
      'myteam',
      [
        { seq: 1, topic: 'decisions', author: 'Atreus-OpenButler', body: 'Decision A.', createdAt: Date.UTC(2026, 9, 14) },
        { seq: 2, topic: 'shared', author: 'Murphy-OpenButler', body: 'Fact B.', createdAt: Date.UTC(2026, 9, 15) },
      ],
      '2026-10-16',
      dataDir,
    );
    const decisions = readFileSync(join(dataDir, 'MEMORY', 'team', 'myteam', 'decisions.md'), 'utf8');
    const shared = readFileSync(join(dataDir, 'MEMORY', 'team', 'myteam', 'shared.md'), 'utf8');
    expect(decisions).toContain('Decision A.');
    expect(decisions).not.toContain('Fact B.');
    expect(shared).toContain('Fact B.');
    expect(shared).not.toContain('Decision A.');
  });

  it('pages the whole log, so a mirror past one page is complete', async () => {
    const entry = (seq: number) => ({ seq, topic: 'decisions' as const, author: 'Atreus-OpenButler', body: `e${seq}`, createdAt: 0 });
    const pages = [
      { entries: [entry(1), entry(2)], latestSeq: 3 },
      { entries: [entry(3)], latestSeq: 3 },
    ];
    let call = 0;
    const channel = { memory: async () => pages[call++]! } as unknown as TeamChannel;
    const result = await readAllTeamMemory(channel);
    expect(result.entries.map((item) => item.seq)).toEqual([1, 2, 3]);
    expect(result.latestSeq).toBe(3);
    expect(call).toBe(2);
  });
});
