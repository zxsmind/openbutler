import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ActivityLedger } from '../src/activity-ledger.js';
import {
  readWorkerOutbox,
  readWorkerRecord,
  writeWorkerOutbox,
  writeWorkerRecord,
  completeWorker,
  appendWorkerNote,
  workerSignalPending,
  acknowledgeWorkerRead,
  recoverWorkers,
} from '../src/worker-records.js';

let ledger: ActivityLedger;

beforeEach(() => {
  ledger = new ActivityLedger(':memory:');
});

afterEach(() => {
  ledger.close();
});

const record = {
  parentSessionId: 'parent-1',
  depth: 1,
  mode: 'executor',
  background: true,
  startedAt: 1_000,
  finished: false,
};

describe('worker lineage records', () => {
  it('round-trips a record', () => {
    expect(readWorkerRecord(ledger, 'w-1')).toBeNull();
    writeWorkerRecord(ledger, 'w-1', record);
    expect(readWorkerRecord(ledger, 'w-1')).toEqual(record);
    writeWorkerRecord(ledger, 'w-1', { ...record, finished: true });
    expect(readWorkerRecord(ledger, 'w-1')).toEqual({ ...record, finished: true });
  });

  it('reads corrupt rows as absent', () => {
    ledger.setState('worker:w-2', 'not-json');
    expect(readWorkerRecord(ledger, 'w-2')).toBeNull();
    ledger.setState('worker:w-2', JSON.stringify({ parentSessionId: 'p' }));
    expect(readWorkerRecord(ledger, 'w-2')).toBeNull();
  });

  it('round-trips notes with a clamped read cursor', () => {
    expect(readWorkerOutbox(ledger, 'w-1')).toEqual({ notes: [], read: 0 });
    writeWorkerOutbox(ledger, 'w-1', { notes: ['one', 'two'], read: 1 });
    expect(readWorkerOutbox(ledger, 'w-1')).toEqual({ notes: ['one', 'two'], read: 1 });
    writeWorkerOutbox(ledger, 'w-1', { notes: ['one'], read: 99 });
    expect(readWorkerOutbox(ledger, 'w-1')).toEqual({ notes: ['one'], read: 1 });
  });
});

it('commits a durable result and its parent event atomically', () => {
  writeWorkerRecord(ledger, 'w-1', record);
  const fail = vi.spyOn(ledger, 'insertEvent').mockImplementationOnce(() => {
    throw new Error('injected event failure');
  });
  expect(() => completeWorker(ledger, 'w-1', { report: 'done', error: null })).toThrow('injected event failure');
  expect(readWorkerRecord(ledger, 'w-1')).toEqual(record);
  fail.mockRestore();
  const id = completeWorker(ledger, 'w-1', { report: 'done', error: null })!;
  expect(ledger.getEvent(id)).toMatchObject({
    source: 'worker',
    kind: 'worker.completed',
    payload: { workerId: 'w-1', parentSessionId: 'parent-1', revision: 1 },
  });
  expect(readWorkerRecord(ledger, 'w-1')?.result).toEqual({ report: 'done', error: null });
  expect(workerSignalPending(ledger, ledger.getEvent(id)!)).toBe(true);
  expect(completeWorker(ledger, 'w-1', { report: 'done', error: null })).toBeNull();
  expect(ledger.pendingEvents()).toHaveLength(1);
});

it('keeps progress quiet and signals only important blocked/question notes', () => {
  writeWorkerRecord(ledger, 'w-1', record);
  appendWorkerNote(ledger, 'w-1', 'halfway', 'progress');
  expect(ledger.pendingEvents()).toHaveLength(0);
  appendWorkerNote(ledger, 'w-1', 'need a decision', 'question');
  const event = ledger.pendingEvents()[0]!;
  expect(event).toMatchObject({ kind: 'worker.question', payload: { note: 2 } });
  acknowledgeWorkerRead(ledger, 'wrong-parent', 'w-1', 0, 2);
  expect(workerSignalPending(ledger, event)).toBe(true);
  acknowledgeWorkerRead(ledger, 'parent-1', 'w-1', 0, 2);
  expect(workerSignalPending(ledger, event)).toBe(false);
});

it('does not redeliver a saved result and recovers an interrupted delivery without losing its identity', () => {
  writeWorkerRecord(ledger, 'w-1', record);
  const id = completeWorker(ledger, 'w-1', { report: 'done', error: null })!;
  ledger.claimEvent(id);
  ledger.recoverInterruptedEvents();
  expect(ledger.getEvent(id)?.status).toBe('pending');
  acknowledgeWorkerRead(ledger, 'parent-1', 'w-1', 1, 0);
  expect(workerSignalPending(ledger, ledger.getEvent(id)!)).toBe(false);
  writeWorkerRecord(ledger, 'w-1', { ...readWorkerRecord(ledger, 'w-1')!, finished: false });
  const next = completeWorker(ledger, 'w-1', { report: 'updated result', error: null })!;
  expect(ledger.getEvent(next)?.payload.revision).toBe(2);
  expect(workerSignalPending(ledger, ledger.getEvent(next)!)).toBe(true);
});

it('records unfinished workers as interrupted after restart without replaying their actions', () => {
  writeWorkerRecord(ledger, 'w-1', record);
  recoverWorkers(ledger);
  expect(readWorkerRecord(ledger, 'w-1')).toMatchObject({
    finished: true,
    completionRevision: 1,
    result: { error: 'Worker interrupted by host restart.' },
  });
  expect(ledger.pendingEvents()[0]?.kind).toBe('worker.failed');
  recoverWorkers(ledger);
  expect(ledger.pendingEvents()).toHaveLength(1);
});
