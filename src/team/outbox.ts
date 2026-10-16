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
  recipient: string;
  body: string;
  replyTo?: string;
  createdAt: number;
}

function readFromDisk(path: string): OutboxEntry[] {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry): entry is OutboxEntry =>
        !!entry &&
        typeof entry === 'object' &&
        typeof (entry as OutboxEntry).msgId === 'string' &&
        typeof (entry as OutboxEntry).recipient === 'string' &&
        typeof (entry as OutboxEntry).body === 'string',
    );
  } catch {
    return [];
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

  /** Queues a message for a team, dropping the oldest entries past the cap. */
  enqueue(input: { teamId: string; recipient: string; body: string; replyTo?: string }): { dropped: number } {
    this.entries.push({
      msgId: makeMessageId(),
      teamId: input.teamId,
      recipient: input.recipient,
      body: input.body,
      ...(input.replyTo ? { replyTo: input.replyTo } : {}),
      createdAt: Date.now(),
    });
    const dropped = Math.max(0, this.entries.length - TEAM_OUTBOX_LIMIT);
    if (dropped > 0) this.entries = this.entries.slice(dropped);
    this.persist();
    return { dropped };
  }

  /** Entries for one team, oldest first. A message for another team is never sent by mistake. */
  list(teamId: string): OutboxEntry[] {
    return this.entries.filter((entry) => entry.teamId === teamId);
  }

  remove(msgId: string): void {
    const next = this.entries.filter((entry) => entry.msgId !== msgId);
    if (next.length !== this.entries.length) {
      this.entries = next;
      this.persist();
    }
  }

  /** Drops every queued message for a team, e.g. when leaving it. */
  clearTeam(teamId: string): void {
    const next = this.entries.filter((entry) => entry.teamId !== teamId);
    if (next.length !== this.entries.length) {
      this.entries = next;
      this.persist();
    }
  }

  size(): number {
    return this.entries.length;
  }

  private persist(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.tmp`;
    writeFileSync(temporary, JSON.stringify(this.entries), 'utf8');
    renameSync(temporary, this.path);
  }
}
