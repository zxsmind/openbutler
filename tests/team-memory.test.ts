import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fetchTeamMemory, postTeamMemory } from '../src/team/client.js';
import { materializeTeamMemory, renderTeamMemoryFile } from '../src/team/memory-mirror.js';
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
  dataDir = mkdtempSync(join(tmpdir(), 'ranite-team-mem-'));
  process.env.RANITE_DATA_DIR = dataDir;
  store = new TeamStore(join(dataDir, 'team.db'));
  const now = Date.now();
  store.initHub('hub-id', 'MyTeam', 'Atreus-Ranite', now);
  store.createJoinRequest('jr_m', 'Murphy-Ranite', 'kartal-2222', now);
  murphyTicket = makeTicket();
  store.decideJoin('jr_m', true, murphyTicket, hashTicket(murphyTicket), now);
  store.revealTicket('jr_m');
  const started = await startTeamServer({ store, bindAddress: '127.0.0.1', port: 0, allowLoopback: true });
  target = { host: '127.0.0.1', port: Number(new URL(started.url).port) };
  server = started;
});

afterEach(async () => {
  await server?.close();
  server = null;
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.RANITE_DATA_DIR;
});

describe('shared team memory over the hub', () => {
  it('appends signed entries and reads them after a sequence', async () => {
    const first = await postTeamMemory(target, murphyTicket, 'decisions', 'We deploy on weekdays only.');
    const second = await postTeamMemory(target, murphyTicket, 'shared', 'The staging URL is internal.');
    expect(second.seq).toBeGreaterThan(first.seq);

    const all = await fetchTeamMemory(target, murphyTicket, 0);
    expect(all.latestSeq).toBe(second.seq);
    expect(all.entries.map((entry) => entry.body)).toEqual(['We deploy on weekdays only.', 'The staging URL is internal.']);
    expect(all.entries.every((entry) => entry.author === 'Murphy-Ranite')).toBe(true);

    const afterFirst = await fetchTeamMemory(target, murphyTicket, first.seq);
    expect(afterFirst.entries.map((entry) => entry.body)).toEqual(['The staging URL is internal.']);
  });

  it('rejects an empty entry and an unknown topic', async () => {
    await expect(postTeamMemory(target, murphyTicket, 'decisions', '   ')).rejects.toThrow('cannot be empty');
    await expect(postTeamMemory(target, murphyTicket, 'shared', 'x'.repeat(9000))).rejects.toThrow('limited to');
  });

  it('behaves the same locally (hub) and remotely (member)', async () => {
    const hub = localChannel(store, 'Atreus-Ranite');
    const member = remoteChannel(target, murphyTicket, 'Murphy-Ranite');
    await hub.remember('decisions', 'The hub wrote this.');
    await member.remember('decisions', 'The member wrote this.');
    const view = await member.memory(0);
    expect(view.entries.map((entry) => entry.author)).toEqual(['Atreus-Ranite', 'Murphy-Ranite']);
  });
});

describe('team memory mirror', () => {
  it('renders a valid memory document, one signed bullet per entry', () => {
    const content = renderTeamMemoryFile(
      'decisions',
      [
        { seq: 1, topic: 'decisions', author: 'Atreus-Ranite', body: 'Deploy on weekdays.', createdAt: Date.UTC(2026, 9, 14) },
        { seq: 2, topic: 'shared', author: 'Murphy-Ranite', body: 'ignored here', createdAt: Date.UTC(2026, 9, 15) },
      ],
      '2026-10-16',
    );
    expect(content).toContain('title: Team decisions');
    expect(content).toContain('type: reference');
    expect(content).toContain('- [2026-10-14 · Atreus-Ranite] Deploy on weekdays.');
    // The other topic's entry is not in this file.
    expect(content).not.toContain('ignored here');
  });

  it('materializes both topic files under the team folder on disk', () => {
    materializeTeamMemory(
      'MyTeam',
      [
        { seq: 1, topic: 'decisions', author: 'Atreus-Ranite', body: 'Decision A.', createdAt: Date.UTC(2026, 9, 14) },
        { seq: 2, topic: 'shared', author: 'Murphy-Ranite', body: 'Fact B.', createdAt: Date.UTC(2026, 9, 15) },
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
});
