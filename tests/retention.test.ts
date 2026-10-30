import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ActivityLedger, type ToolActionUpdate } from '../src/activity-ledger.js';
import { parseRetentionDuration, selectFilesToPrune } from '../src/retention.js';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'openbutler-retention-'));
  if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith('openbutler-retention-')) {
    throw new Error('Unsafe retention fixture path.');
  }
  vi.stubEnv('OPENBUTLER_DATA_DIR', root);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

const action = (requestId: string): ToolActionUpdate => ({
  requestId,
  sessionId: 'session-1',
  workspaceRoot: 'fixture',
  providerId: 'host',
  name: 'inspect',
  input: { path: 'file.txt' },
  effect: { change: 'none', data: 'local', network: 'none', reversible: 'full', outbound: 'model' },
  state: 'proposed',
});

it('parses explicit retention windows', () => {
  expect(parseRetentionDuration('30d')).toBe(2_592_000_000);
  expect(parseRetentionDuration('12h')).toBe(43_200_000);
  expect(parseRetentionDuration('90m')).toBe(5_400_000);
  expect(parseRetentionDuration('2w')).toBe(1_209_600_000);
  expect(() => parseRetentionDuration('soon')).toThrow(/Invalid duration/);
  expect(() => parseRetentionDuration('0d')).toThrow(/Invalid duration/);
  expect(() => parseRetentionDuration('-1d')).toThrow(/Invalid duration/);
  expect(() => parseRetentionDuration('1y')).toThrow(/Invalid duration/);
});

it('selects only files last modified before the cutoff', () => {
  const files = [
    { id: 'old', modifiedAt: 1_000 },
    { id: 'edge', modifiedAt: 2_000 },
    { id: 'new', modifiedAt: 3_000 },
  ];
  expect(selectFilesToPrune(files, 2_000).map((file) => file.id)).toEqual(['old']);
  expect(selectFilesToPrune(files, 0)).toEqual([]);
});

it('prunes only events older than the cutoff', () => {
  const path = join(root, 'state.db');
  const writer = new ActivityLedger(path);
  writer.insertEvent({ source: 'observer', kind: 'tick', dedupeKey: 'old-event', payload: {} });
  writer.insertEvent({ source: 'observer', kind: 'tick', dedupeKey: 'new-event', payload: {} });
  writer.close();
  const raw = new DatabaseSync(path);
  raw.prepare("UPDATE openbutler_events SET received_at = '2020-01-01T00:00:00.000Z' WHERE dedupe_key = 'old-event'").run();
  raw.close();

  const ledger = new ActivityLedger(path);
  try {
    const cutoff = new Date(Date.now() - 86_400_000).toISOString();
    expect(ledger.previewPruneBefore(cutoff, 'events')).toEqual({ events: 1, actions: 0, transitions: 0 });
    expect(ledger.pruneBefore(cutoff, 'events')).toEqual({ events: 1, actions: 0, transitions: 0 });
    expect(ledger.previewPruneBefore(cutoff, 'events').events).toBe(0);
    expect(ledger.listEvents().map((row) => row.dedupeKey)).toEqual(['new-event']);
  } finally {
    ledger.close();
  }
});

it('prunes an old action and its transitions but keeps newer actions', () => {
  const path = join(root, 'state.db');
  const writer = new ActivityLedger(path);
  for (const requestId of ['action-old', 'action-new']) {
    for (const state of ['proposed', 'approved', 'started', 'completed'] as const) {
      writer.recordToolAction({ ...action(requestId), state });
    }
  }
  writer.close();
  const raw = new DatabaseSync(path);
  raw.prepare("UPDATE openbutler_actions SET created_at = '2020-01-01T00:00:00.000Z' WHERE request_id = 'action-old'").run();
  raw.close();

  const ledger = new ActivityLedger(path);
  try {
    const cutoff = new Date(Date.now() - 86_400_000).toISOString();
    const preview = ledger.previewPruneBefore(cutoff, 'actions');
    expect(preview.actions).toBe(1);
    expect(preview.transitions).toBeGreaterThan(0);
    expect(ledger.pruneBefore(cutoff, 'actions')).toEqual(preview);
    expect(ledger.listActions().map((row) => row.requestId)).toEqual(['action-new']);
    expect(ledger.previewPruneBefore(cutoff, 'actions')).toEqual({ events: 0, actions: 0, transitions: 0 });
  } finally {
    ledger.close();
  }
});

it('lists only real session files for pruning', async () => {
  vi.resetModules();
  const { createSession, listSessionFiles, saveSession } = await import('../src/session-store.js');
  const session = createSession('fixture', 'fixture', 262_144, root);
  session.entries.push({ kind: 'user', text: 'retention fixture' });
  const saved = saveSession(session);
  writeFileSync(join(root, 'sessions', 'not-a-session.json'), '{}');
  const files = listSessionFiles();
  expect(files.map((file) => file.id)).toEqual([saved.id]);
  expect(files[0]!.sizeBytes).toBeGreaterThan(0);
  expect(selectFilesToPrune(files, Date.now() + 1_000).map((file) => file.id)).toEqual([saved.id]);
});
