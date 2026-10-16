import type { ActivityLedger } from './activity-ledger.js';

/**
 * Durable subagent worker lineage. The live `workers` map owns running
 * workers; these state keys own the truth across host restarts, so a parent
 * can still poll a finished worker after the host comes back. Corrupt or
 * partial rows read as absent: a worker that cannot be proven is not a
 * worker.
 */
export interface WorkerRecord {
  parentSessionId: string;
  depth: number;
  mode: string;
  background: boolean;
  startedAt: number;
  finished: boolean;
}

export interface WorkerOutbox {
  notes: string[];
  read: number;
}

type StateReader = Pick<ActivityLedger, 'getState'>;
type StateWriter = Pick<ActivityLedger, 'getState' | 'setState'>;

const recordKey = (workerId: string): string => `worker:${workerId}`;
const outboxKey = (workerId: string): string => `worker:${workerId}:notes`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function readWorkerRecord(ledger: StateReader, workerId: string): WorkerRecord | null {
  const raw = ledger.getState(recordKey(workerId));
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      !isRecord(parsed) ||
      typeof parsed.parentSessionId !== 'string' ||
      typeof parsed.depth !== 'number' ||
      typeof parsed.mode !== 'string' ||
      typeof parsed.background !== 'boolean' ||
      typeof parsed.startedAt !== 'number' ||
      typeof parsed.finished !== 'boolean'
    )
      return null;
    return {
      parentSessionId: parsed.parentSessionId,
      depth: parsed.depth,
      mode: parsed.mode,
      background: parsed.background,
      startedAt: parsed.startedAt,
      finished: parsed.finished,
    };
  } catch {
    return null;
  }
}

export function writeWorkerRecord(ledger: StateWriter, workerId: string, record: WorkerRecord): void {
  ledger.setState(recordKey(workerId), JSON.stringify(record));
}

export function readWorkerOutbox(ledger: StateReader, workerId: string): WorkerOutbox {
  const raw = ledger.getState(outboxKey(workerId));
  if (!raw) return { notes: [], read: 0 };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || !Array.isArray(parsed.notes) || !parsed.notes.every((note) => typeof note === 'string'))
      return { notes: [], read: 0 };
    const notes = parsed.notes as string[];
    const read = typeof parsed.read === 'number' && parsed.read >= 0 ? Math.min(Math.floor(parsed.read), notes.length) : 0;
    return { notes: [...notes], read };
  } catch {
    return { notes: [], read: 0 };
  }
}

export function writeWorkerOutbox(ledger: StateWriter, workerId: string, outbox: WorkerOutbox): void {
  ledger.setState(outboxKey(workerId), JSON.stringify({ notes: outbox.notes, read: outbox.read }));
}
