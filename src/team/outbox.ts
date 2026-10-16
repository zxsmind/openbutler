import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { getDataPath } from '../paths.js';
import { makeMessageId } from './service.js';

/** Cap on locally queued outbound messages while the hub is unreachable. */
export const TEAM_OUTBOX_LIMIT = 100;

export interface OutboxEntry {
  recipient: string;
  body: string;
  replyTo?: string;
  msgId: string;
}

function outboxPath(): string {
  return getDataPath('team-outbox.json');
}

/** Reads the local outbox; a missing or damaged file reads as empty. */
export function readOutbox(): OutboxEntry[] {
  try {
    const parsed: unknown = JSON.parse(readFileSync(outboxPath(), 'utf8'));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry): entry is OutboxEntry =>
        !!entry &&
        typeof entry === 'object' &&
        typeof (entry as OutboxEntry).recipient === 'string' &&
        typeof (entry as OutboxEntry).body === 'string' &&
        typeof (entry as OutboxEntry).msgId === 'string',
    );
  } catch {
    return [];
  }
}

function writeOutbox(entries: OutboxEntry[]): void {
  const path = outboxPath();
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, JSON.stringify(entries), 'utf8');
  renameSync(temporary, path);
}

/**
 * Queues one message for delivery when the hub returns. The message id is
 * minted here so a later flush is idempotent on the hub even across restarts.
 * Oldest entries are dropped past the cap so the queue stays bounded.
 */
export function enqueueOutbox(entry: { recipient: string; body: string; replyTo?: string }): { queued: boolean; dropped: number } {
  const existing = readOutbox();
  const next = [...existing, { ...entry, msgId: makeMessageId() }];
  const dropped = Math.max(0, next.length - TEAM_OUTBOX_LIMIT);
  writeOutbox(next.slice(dropped));
  return { queued: true, dropped };
}

export function replaceOutbox(entries: OutboxEntry[]): void {
  writeOutbox(entries);
}

export function outboxExists(): boolean {
  return existsSync(outboxPath());
}
