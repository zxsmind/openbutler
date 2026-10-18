import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { getDataPath } from '../paths.js';
import { makeMessageId } from './service.js';

/** Cap on locally queued outbound messages while the hub is unreachable. */
export const TEAM_OUTBOX_LIMIT = 100;

export interface OutboxEntry {
  /** Stable identity from the moment it is queued, so a retry is idempotent on the hub. */
  msgId: string;
  /** The team this message belongs to, so a message never lands in the wrong team. */
  teamId: string;
  bindingKey?: string;
  file?: { id: string; name: string; size: number; sha256: string };
  state?: 'pending' | 'failed' | 'sent' | 'cancelled';
  settledAt?: number;
  attempts?: number;
  nextAttemptAt?: number;
  error?: string;
  recipient: string;
  body: string;
  replyTo?: string;
  createdAt: number;
}

function readFromDisk(path: string): OutboxEntry[] {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!Array.isArray(parsed)) throw new Error('Invalid outbox document.');
    const entries = parsed.filter(
      (entry): entry is OutboxEntry =>
        !!entry &&
        typeof entry === 'object' &&
        typeof (entry as OutboxEntry).msgId === 'string' &&
        typeof (entry as OutboxEntry).recipient === 'string' &&
        typeof (entry as OutboxEntry).body === 'string',
    );
    if (entries.length !== parsed.length) throw new Error('Invalid outbox entry.');
    return entries;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new Error('Cannot read the team outbox; refusing to overwrite it.', { cause: error });
  }
}

/**
 * The single owner of locally queued outbound messages. The daemon is the only
 * producer and the only consumer, so the in-memory list is the authority and
 * the file is a write-through copy for restarts. Because a flush removes each
 * entry by its own id from the live list, a message enqueued while a flush is
 * waiting on the network is never lost, and the stable `msgId` makes a retry a
 * no-op on the hub.
 */
export class TeamOutbox {
  private entries: OutboxEntry[];

  constructor(private readonly path: string = getDataPath('team-outbox.json')) {
    this.entries = readFromDisk(this.path);
  }

  /** Persist before sending. Capacity pressure never discards an accepted delivery. */
  enqueue(input: {
    teamId: string;
    recipient: string;
    body: string;
    replyTo?: string;
    msgId?: string;
    bindingKey?: string;
    file?: OutboxEntry['file'];
  }): { dropped: number; msgId: string } {
    if (this.size() >= TEAM_OUTBOX_LIMIT) throw new Error('Team outbox is full. Resolve pending or failed deliveries before sending more.');
    const msgId = input.msgId ?? makeMessageId();
    const next = [
      ...this.entries,
      {
        msgId,
        teamId: input.teamId,
        ...(input.bindingKey === undefined ? {} : { bindingKey: input.bindingKey }),
        ...(input.file ? { file: input.file } : {}),
        state: 'pending',
        attempts: 0,
        nextAttemptAt: 0,
        recipient: input.recipient,
        body: input.body,
        ...(input.replyTo ? { replyTo: input.replyTo } : {}),
        createdAt: Date.now(),
      } satisfies OutboxEntry,
    ];
    this.commit(next);
    return { dropped: 0, msgId };
  }

  outcome(msgId: string, error: string, retryable: boolean): void {
    const entry = this.entries.find((item) => item.msgId === msgId);
    if (!entry || entry.state === 'sent' || entry.state === 'cancelled') return;
    const attempts = (entry.attempts ?? 0) + 1;
    const next: OutboxEntry = {
      ...entry,
      attempts,
      error,
      state: retryable ? 'pending' : 'failed',
      nextAttemptAt: retryable ? Date.now() + Math.min(60_000, 1000 * 2 ** Math.min(attempts, 6)) : 0,
    };
    this.commit(this.entries.map((item) => (item.msgId === msgId ? next : item)));
  }

  /** Entries for one team, oldest first. A message for another team is never sent by mistake. */
  list(teamId: string): OutboxEntry[] {
    return structuredClone(
      this.entries.filter((entry) => entry.teamId === teamId && entry.state !== 'sent' && entry.state !== 'cancelled'),
    );
  }

  remove(msgId: string): void {
    const next = this.entries.filter((entry) => entry.msgId !== msgId);
    if (next.length !== this.entries.length) {
      this.commit(next);
    }
  }

  /** Drops every queued message for a team, e.g. when leaving it. */
  clearTeam(teamId: string): void {
    const next = this.entries.filter((entry) => entry.teamId !== teamId);
    if (next.length !== this.entries.length) {
      this.commit(next);
    }
  }

  size(): number {
    return this.entries.filter((entry) => entry.state !== 'sent' && entry.state !== 'cancelled').length;
  }

  all(): OutboxEntry[] {
    return structuredClone(this.entries);
  }

  get(msgId: string): OutboxEntry | undefined {
    const entry = this.entries.find((item) => item.msgId === msgId);
    return entry ? structuredClone(entry) : undefined;
  }

  retry(msgId: string): void {
    const entry = this.entries.find((item) => item.msgId === msgId);
    if (!entry) throw new Error('No such pending or failed delivery.');
    if (entry.state === 'sent' || entry.state === 'cancelled') throw new Error('A settled delivery cannot be queued again.');
    this.commit(this.entries.map((item) => (item.msgId === msgId ? { ...item, state: 'pending' as const, nextAttemptAt: 0 } : item)));
  }

  settle(msgId: string, state: 'sent' | 'cancelled'): void {
    this.commit(
      this.entries.map((entry) => {
        if (entry.msgId !== msgId) return entry;
        const settled = { ...entry, state, settledAt: Date.now() };
        delete settled.error;
        delete settled.nextAttemptAt;
        return settled;
      }),
    );
  }

  private commit(next: OutboxEntry[]): void {
    // Pending intent is never evicted. Only the oldest settled receipts expire.
    const receipts = next
      .filter((entry) => entry.state === 'sent' || entry.state === 'cancelled')
      .sort((a, b) => (b.settledAt ?? 0) - (a.settledAt ?? 0));
    const expired = new Set(receipts.slice(1000).map((entry) => entry.msgId));
    next = next.filter((entry) => !expired.has(entry.msgId));
    mkdirSync(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.tmp`;
    writeFileSync(temporary, JSON.stringify(next), 'utf8');
    renameSync(temporary, this.path);
    this.entries = next;
  }
}
