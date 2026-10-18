import { copyFile, mkdir, rm, stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { getDataPath } from '../paths.js';
import { TeamTransportError } from './contracts.js';
import { TeamError, MAX_FILE_BYTES } from './operations.js';
import { TeamOutbox } from './outbox.js';
import { hashFile, outboundFilePath } from './files.js';
import { makeFileId } from './service.js';
import type { TeamConnection } from './session.js';

/** Owns durable outbound intent, retries and terminal failures for text and files. */
export const MAX_LOCAL_FAILURE_ATTEMPTS = 6;

export class TeamDelivery {
  private readonly inFlight = new Set<string>();
  private flushing: Promise<void> | null = null;
  private closed = false;

  constructor(
    private readonly connect: () => TeamConnection,
    private readonly outbox = new TeamOutbox(),
  ) {}

  async send(input: { recipient: string; text: string; replyTo?: string }): Promise<unknown> {
    if (this.closed) throw new Error('Team delivery is shutting down.');
    const connection = this.connect();
    try {
      const { msgId } = this.outbox.enqueue({
        teamId: connection.teamId,
        bindingKey: connection.key,
        recipient: input.recipient,
        body: input.text,
        ...(input.replyTo ? { replyTo: input.replyTo } : {}),
      });
      await this.attempt(connection, msgId);
      return this.result(connection.teamId, msgId, input.recipient);
    } finally {
      connection.close();
    }
  }

  async sendFile(input: { path: string; to: string }): Promise<unknown> {
    if (this.closed) throw new Error('Team delivery is shutting down.');
    const connection = this.connect();
    let staged: string | undefined;
    try {
      const source = await stat(input.path);
      if (!source.isFile() || source.size > MAX_FILE_BYTES) throw new TeamError('Source must be a file of at most 1 GB.', 400);
      const id = makeFileId();
      const directory = getDataPath('team-outbound-files');
      await mkdir(directory, { recursive: true });
      staged = outboundFilePath(id);
      await copyFile(input.path, staged);
      const info = await stat(staged);
      const file = { id, name: basename(input.path), size: info.size, sha256: await hashFile(staged) };
      if (this.closed || !connection.isCurrent()) throw new Error('Team membership changed before the file could be queued.');
      const { msgId } = this.outbox.enqueue({
        teamId: connection.teamId,
        bindingKey: connection.key,
        recipient: input.to,
        body: file.name,
        file,
      });
      staged = undefined; // The durable queue now owns this snapshot.
      // File I/O belongs to background delivery, so a slow peer cannot hold an agent tool batch.
      void this.flush().catch((error: unknown) => {
        if (!this.closed) this.outbox.outcome(msgId, String(error), true);
      });
      return { ...this.result(connection.teamId, msgId, input.to), fileId: id };
    } finally {
      connection.close();
      if (staged) await rm(staged, { force: true });
    }
  }

  flush(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.flushing) return this.flushing;
    this.flushing = this.drain().finally(() => {
      this.flushing = null;
    });
    return this.flushing;
  }

  private async drain(): Promise<void> {
    const connection = this.connect();
    try {
      for (const entry of this.outbox.list(connection.teamId)) {
        if (this.closed || !connection.isCurrent()) break;
        if (entry.state === 'failed' || (entry.nextAttemptAt ?? 0) > Date.now()) continue;
        await this.attempt(connection, entry.msgId);
      }
    } finally {
      connection.close();
    }
  }

  private async attempt(connection: TeamConnection, id: string): Promise<void> {
    if (this.closed) return;
    const entry = this.outbox.get(id);
    if (
      !entry ||
      (entry.state !== undefined && entry.state !== 'pending') ||
      (entry.nextAttemptAt ?? 0) > Date.now() ||
      this.inFlight.has(id) ||
      !connection.isCurrent()
    )
      return;
    if (entry.bindingKey !== connection.key) {
      this.outbox.outcome(entry.msgId, 'Delivery belongs to a different or unknown membership. It was retained without sending.', false);
      return;
    }
    this.inFlight.add(entry.msgId);
    try {
      if (entry.file)
        await connection.channel.sendFile({ recipient: entry.recipient, path: outboundFilePath(entry.file.id), transfer: entry.file });
      else await connection.channel.send(entry.recipient, entry.body, entry.replyTo, entry.msgId);
      // Shutdown transfers durable ownership to the next host. Its stable-id retry
      // reconciles a possibly accepted remote operation; this host must not write.
      if (this.closed) return;
      this.outbox.settle(entry.msgId, 'sent');
      if (entry.file) await rm(outboundFilePath(entry.file.id), { force: true });
    } catch (error) {
      if (this.closed) return;
      // A transport failure reports its own retryability; a business rejection is
      // final; anything else is a local fault (a bug, a missing file, a full disk)
      // that will not cure itself. Retrying that a few times is harmless, but
      // looping forever behind the word "queued" hides a delivery that never
      // happens, so after MAX_LOCAL_FAILURE_ATTEMPTS the record fails visibly.
      const retryable =
        error instanceof TeamTransportError
          ? error.retryable
          : !(error instanceof TeamError) && (entry.attempts ?? 0) < MAX_LOCAL_FAILURE_ATTEMPTS;
      this.outbox.outcome(entry.msgId, error instanceof Error ? error.message : String(error), retryable);
    } finally {
      this.inFlight.delete(entry.msgId);
    }
  }

  status(teamId: string): Array<{ id: string; recipient: string; state: string; error?: string; nextAttemptAt?: number }> {
    return this.outbox.list(teamId).map((entry) => ({
      id: entry.msgId,
      recipient: entry.recipient,
      state: entry.state ?? 'pending',
      ...(entry.error ? { error: entry.error } : {}),
      ...(entry.nextAttemptAt === undefined ? {} : { nextAttemptAt: entry.nextAttemptAt }),
    }));
  }

  async manage(input: Record<string, unknown>): Promise<unknown> {
    if (this.closed) throw new Error('Team delivery is shutting down.');
    if (input.action === 'list') {
      const limit = input.limit ?? 20;
      const offset = input.offset ?? 0;
      if (!Number.isSafeInteger(limit) || Number(limit) < 1 || Number(limit) > 100 || !Number.isSafeInteger(offset) || Number(offset) < 0)
        throw new Error('Invalid delivery page.');
      const records = this.outbox.all().sort((a, b) => (b.settledAt ?? b.createdAt) - (a.settledAt ?? a.createdAt));
      return {
        status: 'ok',
        total: records.length,
        deliveries: records
          .slice(Number(offset), Number(offset) + Number(limit))
          .map(({ body, ...entry }) => ({ ...entry, preview: body.slice(0, 240) })),
      };
    }
    if (input.action !== 'read' && input.action !== 'retry' && input.action !== 'cancel') throw new Error('Unknown delivery action.');
    const entry = this.outbox.all().find((item) => item.msgId === input.id);
    if (!entry) throw new Error('No retained delivery with that id.');
    if (input.action === 'read') return { status: 'ok', delivery: entry };
    if (entry.state === 'sent') {
      if (input.action === 'cancel') throw new Error('An accepted remote delivery cannot be retracted.');
      return this.result(entry.teamId, entry.msgId, entry.recipient);
    }
    if (entry.state === 'cancelled') {
      if (input.action === 'retry') throw new Error('Create a new intent instead of reviving a cancelled delivery.');
      return { status: 'cancelled', messageId: entry.msgId };
    }
    if (this.inFlight.has(entry.msgId))
      throw new Error('Delivery is in progress; its remote outcome must settle before retry or cancellation.');
    if (input.action === 'cancel') {
      this.outbox.settle(entry.msgId, 'cancelled');
      if (entry.file) await rm(outboundFilePath(entry.file.id), { force: true });
      return { status: 'cancelled', messageId: entry.msgId };
    }
    const connection = this.connect();
    try {
      if (!connection.isCurrent() || entry.bindingKey !== connection.key) throw new Error('Retry requires the original team membership.');
      this.outbox.retry(entry.msgId);
      await this.attempt(connection, entry.msgId);
      return this.result(connection.teamId, entry.msgId, entry.recipient);
    } finally {
      connection.close();
    }
  }

  close(): void {
    this.closed = true;
  }

  private result(
    teamId: string,
    msgId: string,
    recipient: string,
  ): { status: string; messageId: string; recipient: string; error?: string } {
    const entry = this.outbox.get(msgId);
    return {
      status:
        entry?.teamId !== teamId
          ? 'unknown'
          : entry.state === 'sent'
            ? 'sent'
            : entry.state === 'cancelled'
              ? 'cancelled'
              : entry.state === 'failed'
                ? 'error'
                : 'queued',
      messageId: msgId,
      recipient,
      ...(entry?.error ? { error: entry.error } : {}),
    };
  }
}
