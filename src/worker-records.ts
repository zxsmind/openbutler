import type { ActivityLedger, ObservedEventRow } from './activity-ledger.js';

export const WORKER_NOTE_KINDS = ['progress', 'blocked', 'question'] as const;
export type WorkerNoteKind = (typeof WORKER_NOTE_KINDS)[number];
export type ParentMessageInput = { text: string; kind?: WorkerNoteKind };

export function acknowledgeWorkerRead(
  ledger: ActivityLedger,
  parentId: string,
  workerId: string,
  revision: number,
  notesCursor: number,
): void {
  ledger.transaction(() => {
    const record = readWorkerRecord(ledger, workerId);
    if (!record || record.parentSessionId !== parentId) return;
    const outbox = readWorkerOutbox(ledger, workerId);
    outbox.read = Math.max(outbox.read, Math.min(notesCursor, outbox.notes.length));
    writeWorkerOutbox(ledger, workerId, outbox);
    if (record.finished && revision === record.completionRevision)
      writeWorkerRecord(ledger, workerId, { ...record, reportedRevision: revision });
  });
}

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
  workspaceRoot?: string;
  completionRevision?: number;
  reportedRevision?: number;
  result?: { report: string; error: string | null };
  context?: { paths: string[]; notes?: string };
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
      ...(typeof parsed.workspaceRoot === 'string' ? { workspaceRoot: parsed.workspaceRoot } : {}),
      ...(Number.isSafeInteger(parsed.completionRevision) ? { completionRevision: Number(parsed.completionRevision) } : {}),
      ...(Number.isSafeInteger(parsed.reportedRevision) ? { reportedRevision: Number(parsed.reportedRevision) } : {}),
      ...(isRecord(parsed.result) &&
      typeof parsed.result.report === 'string' &&
      (parsed.result.error === null || typeof parsed.result.error === 'string')
        ? { result: { report: parsed.result.report, error: parsed.result.error } }
        : {}),
      ...(isRecord(parsed.context) && Array.isArray(parsed.context.paths) && parsed.context.paths.every((path) => typeof path === 'string')
        ? {
            context: {
              paths: parsed.context.paths as string[],
              ...(typeof parsed.context.notes === 'string' ? { notes: parsed.context.notes } : {}),
            },
          }
        : {}),
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

/** Completion, durable report and wake identity have one transaction owner. */
export function completeWorker(ledger: ActivityLedger, workerId: string, result: { report: string; error: string | null }): string | null {
  return ledger.transaction(() => {
    const record = readWorkerRecord(ledger, workerId);
    if (!record || record.finished) return null;
    const revision = (record.completionRevision ?? 0) + 1;
    writeWorkerRecord(ledger, workerId, { ...record, finished: true, completionRevision: revision, result });
    if (!record.background) return null;
    return ledger.insertEvent({
      source: 'worker',
      kind: result.error === 'Run cancelled.' ? 'worker.cancelled' : result.error ? 'worker.failed' : 'worker.completed',
      dedupeKey: `worker:${workerId}:completion:${revision}`,
      ...(record.workspaceRoot ? { workspaceRoot: record.workspaceRoot } : {}),
      payload: { workerId, parentSessionId: record.parentSessionId, revision },
    }).id;
  });
}

export function appendWorkerNote(ledger: ActivityLedger, workerId: string, text: string, kind: WorkerNoteKind): void {
  ledger.transaction(() => {
    const record = readWorkerRecord(ledger, workerId);
    if (!record?.background) throw new Error('Only a background worker can leave parent notes.');
    const outbox = readWorkerOutbox(ledger, workerId);
    outbox.notes.push(text);
    writeWorkerOutbox(ledger, workerId, outbox);
    if (kind === 'progress') return;
    ledger.insertEvent({
      source: 'worker',
      kind: `worker.${kind}`,
      dedupeKey: `worker:${workerId}:note:${outbox.notes.length}`,
      ...(record.workspaceRoot ? { workspaceRoot: record.workspaceRoot } : {}),
      payload: { workerId, parentSessionId: record.parentSessionId, note: outbox.notes.length },
    });
  });
}

export function workerSignalPending(ledger: ActivityLedger, event: ObservedEventRow): boolean {
  const workerId = event.payload.workerId;
  if (typeof workerId !== 'string') return false;
  const record = readWorkerRecord(ledger, workerId);
  if (!record?.background || record.parentSessionId !== event.payload.parentSessionId) return false;
  if (typeof event.payload.note === 'number') return readWorkerOutbox(ledger, workerId).read < event.payload.note;
  return (
    record.finished &&
    record.completionRevision === event.payload.revision &&
    (record.reportedRevision ?? 0) < (record.completionRevision ?? 0)
  );
}

/** Recover the outcome, never replay unfinished worker actions after a host restart. */
export function recoverWorkers(ledger: ActivityLedger): void {
  for (const entry of ledger.stateEntries('worker:')) {
    const id = entry.key.slice('worker:'.length);
    if (id.includes(':')) continue;
    const record = readWorkerRecord(ledger, id);
    if (record && !record.finished)
      completeWorker(ledger, id, {
        report: 'The host stopped before this worker completed. Inspect its saved session for partial evidence.',
        error: 'Worker interrupted by host restart.',
      });
  }
}
