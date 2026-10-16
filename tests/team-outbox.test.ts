import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { enqueueOutbox, readOutbox, replaceOutbox, TEAM_OUTBOX_LIMIT } from '../src/team/outbox.js';

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'ranite-outbox-'));
  process.env.RANITE_DATA_DIR = dataDir;
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.RANITE_DATA_DIR;
});

describe('team outbox', () => {
  it('reads empty when there is no file, and round-trips queued messages', () => {
    expect(readOutbox()).toEqual([]);
    enqueueOutbox({ recipient: 'group', body: 'hello' });
    enqueueOutbox({ recipient: 'Atreus-Ranite', body: 'psst', replyTo: 'm_1' });
    const entries = readOutbox();
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ recipient: 'group', body: 'hello' });
    expect(entries[1]).toMatchObject({ recipient: 'Atreus-Ranite', body: 'psst', replyTo: 'm_1' });
    // Each entry carries a unique message id so a flush is idempotent.
    expect(new Set(entries.map((entry) => entry.msgId)).size).toBe(2);
  });

  it('drops the oldest entries past the cap so the queue stays bounded', () => {
    for (let index = 0; index < TEAM_OUTBOX_LIMIT + 5; index++) enqueueOutbox({ recipient: 'group', body: `msg ${index}` });
    const entries = readOutbox();
    expect(entries).toHaveLength(TEAM_OUTBOX_LIMIT);
    // The five oldest were dropped; the newest is present.
    expect(entries[0]?.body).toBe('msg 5');
    expect(entries.at(-1)?.body).toBe(`msg ${TEAM_OUTBOX_LIMIT + 4}`);
  });

  it('replaces the queue wholesale after a partial flush', () => {
    enqueueOutbox({ recipient: 'group', body: 'a' });
    enqueueOutbox({ recipient: 'group', body: 'b' });
    const [first] = readOutbox();
    replaceOutbox([first!]);
    expect(readOutbox().map((entry) => entry.body)).toEqual(['a']);
    replaceOutbox([]);
    expect(readOutbox()).toEqual([]);
  });
});
