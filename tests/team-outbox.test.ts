import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TeamOutbox, TEAM_OUTBOX_LIMIT } from '../src/team/outbox.js';

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'openbutler-outbox-'));
  path = join(dir, 'team-outbox.json');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('team outbox', () => {
  it('queues, lists, and removes entries with stable identities', () => {
    const outbox = new TeamOutbox(path);
    outbox.enqueue({ teamId: 't_a', recipient: 'group', body: 'hello' });
    outbox.enqueue({ teamId: 't_a', recipient: 'Atreus-OpenButler', body: 'psst', replyTo: 'm_1' });
    const entries = outbox.list('t_a');
    expect(entries).toHaveLength(2);
    expect(entries[1]).toMatchObject({ recipient: 'Atreus-OpenButler', replyTo: 'm_1' });
    expect(new Set(entries.map((entry) => entry.msgId)).size).toBe(2);

    outbox.remove(entries[0]!.msgId);
    expect(outbox.list('t_a').map((entry) => entry.body)).toEqual(['psst']);
  });

  it('never loses a message enqueued while another is being removed', () => {
    const outbox = new TeamOutbox(path);
    outbox.enqueue({ teamId: 't_a', recipient: 'group', body: 'A' });
    const [a] = outbox.list('t_a');
    // A flush is mid-flight on A when B is enqueued; removing A must not drop B.
    outbox.enqueue({ teamId: 't_a', recipient: 'group', body: 'B' });
    outbox.remove(a!.msgId);
    expect(outbox.list('t_a').map((entry) => entry.body)).toEqual(['B']);
  });

  it('refuses new work at capacity without losing previously accepted deliveries', () => {
    const outbox = new TeamOutbox(path);
    for (let index = 0; index < TEAM_OUTBOX_LIMIT; index++) outbox.enqueue({ teamId: 't_a', recipient: 'group', body: `msg ${index}` });
    expect(() => outbox.enqueue({ teamId: 't_a', recipient: 'group', body: 'overflow' })).toThrow('full');
    expect(new TeamOutbox(path).list('t_a')).toHaveLength(TEAM_OUTBOX_LIMIT);
    expect(outbox.list('t_a')[0]?.body).toBe('msg 0');
  });

  it('keeps teams separate so a message never lands in the wrong team', () => {
    const outbox = new TeamOutbox(path);
    outbox.enqueue({ teamId: 't_a', recipient: 'group', body: 'for A' });
    outbox.enqueue({ teamId: 't_b', recipient: 'group', body: 'for B' });
    expect(outbox.list('t_a').map((entry) => entry.body)).toEqual(['for A']);
    expect(outbox.list('t_b').map((entry) => entry.body)).toEqual(['for B']);
    outbox.clearTeam('t_a');
    expect(outbox.list('t_a')).toEqual([]);
    expect(outbox.list('t_b')).toHaveLength(1);
  });

  it('survives a restart by reloading from disk', () => {
    const first = new TeamOutbox(path);
    first.enqueue({ teamId: 't_a', recipient: 'group', body: 'persisted' });
    const second = new TeamOutbox(path);
    expect(second.list('t_a').map((entry) => entry.body)).toEqual(['persisted']);
  });
});
