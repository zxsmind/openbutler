import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ActivityLedger } from '../src/activity-ledger.js';
import { readWorkerOutbox, readWorkerRecord, writeWorkerOutbox, writeWorkerRecord } from '../src/worker-records.js';

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
