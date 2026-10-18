import { GROUP_RECIPIENT, isGroupRecipient, makeFileId, makeMessageId, validateMemberName } from './service.js';
import { MAX_TEAM_MESSAGE_ID_CHARS } from './contracts.js';
import type { TeamMemoryTopic, TeamMessage, TeamStore, TeamFile } from './store.js';

export const MAX_MESSAGE_CHARS = 8000;
/** Largest file the hub will accept and relay, in bytes. */
export const MAX_FILE_BYTES = 1024 * 1024 * 1024;

/**
 * A rejected team operation carrying the HTTP status the transport should use.
 * Business rules throw this; the transport only maps it. The rule lives here,
 * once, and never in a transport handler.
 */
export class TeamError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'TeamError';
  }
}

export type PostMessageResult = { duplicate: true; msgId: string } | { duplicate: false; message: TeamMessage };

/**
 * The single owner of team business rules. Both transports — the hub's HTTP
 * surface and the hub's own local channel — go through here, so a message is
 * validated and canonicalized the same way no matter which path it takes.
 * The store stays a dumb persistence layer; nothing else writes to it.
 */
export class TeamOperations {
  constructor(private readonly store: TeamStore) {}

  readGroup(member: string, limit: number) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new TeamError('Group limit must be 1-200.', 400);
    const cursor = this.store.getGroupCursor(member);
    return { messages: this.store.groupMessages(cursor, limit), cursor, latestSeq: this.store.groupLatestSeq() };
  }

  acknowledgeGroup(member: string, seq: number): number {
    if (!Number.isSafeInteger(seq) || seq < 0 || seq > this.store.groupLatestSeq())
      throw new TeamError('Invalid group acknowledgement sequence.', 400);
    this.store.setGroupCursor(member, seq);
    return this.store.getGroupCursor(member);
  }

  /**
   * Resolves a recipient to its canonical form: the group channel, or an
   * active member's real name (matched case-insensitively). Unknown or
   * invalid recipients are refused here, once, for every path.
   */
  resolveRecipient(recipient: string): string {
    const trimmed = recipient.trim();
    if (isGroupRecipient(trimmed)) return GROUP_RECIPIENT;
    let valid: string;
    try {
      valid = validateMemberName(trimmed);
    } catch {
      throw new TeamError(`"${recipient}" is not a valid recipient.`, 400);
    }
    const canonical = this.store.canonicalMemberName(valid);
    if (!canonical) throw new TeamError(`No member named "${valid}" in this team.`, 404);
    return canonical;
  }

  /**
   * Validates and stores one message under the hub clock. The recipient is
   * stored canonically, and a repeated `msgId` is recognised as a retry so it
   * is never delivered twice. Replying to a direct message (replyTo) also
   * acknowledges it for the sender, so answering a message closes it without a
   * separate step.
   */
  postMessage(sender: string, input: { recipient: string; body: string; replyTo?: string | null; msgId?: string }): PostMessageResult {
    if (!input.body.trim()) throw new TeamError('A message body cannot be empty.', 400);
    if (input.body.length > MAX_MESSAGE_CHARS) throw new TeamError(`A message body is limited to ${MAX_MESSAGE_CHARS} characters.`, 400);
    const msgId = input.msgId && input.msgId.trim() ? input.msgId : makeMessageId();
    if (msgId.length > MAX_TEAM_MESSAGE_ID_CHARS) throw new TeamError('Message id is too long.', 400);
    return this.store.transaction(() => {
      const existing = this.store.getMessage(msgId);
      if (existing) {
        if (
          existing.sender !== sender ||
          existing.recipient.toLowerCase() !== input.recipient.trim().toLowerCase() ||
          existing.kind !== 'text' ||
          existing.body !== input.body ||
          existing.replyTo !== (input.replyTo ?? null)
        )
          throw new TeamError('Message id already belongs to a different operation.', 409);
        // Also repair a historical split reply/ack when a matching operation retries.
        if (input.replyTo) this.store.ackDms(sender, [input.replyTo], Date.now());
        return { duplicate: true, msgId };
      }
      const recipient = this.resolveRecipient(input.recipient);
      const message = this.store.postMessage({
        msgId,
        sender,
        recipient,
        body: input.body,
        createdAt: Date.now(),
        replyTo: input.replyTo ?? null,
      });
      // A reply closes the message it answers: acknowledge any replyTo id that is
      // a direct message this sender owns (ackDms only touches the sender's own
      // inbox, so a group id or another member's id is a no-op).
      if (input.replyTo) this.store.ackDms(sender, [input.replyTo], Date.now());
      return { duplicate: false, message };
    });
  }

  /** Validates and appends one signed shared-memory entry. */
  appendMemory(author: string, topic: TeamMemoryTopic, body: string): number {
    if (topic !== 'decisions' && topic !== 'shared') throw new TeamError('topic must be "decisions" or "shared".', 400);
    if (!body.trim()) throw new TeamError('A memory entry cannot be empty.', 400);
    if (body.length > MAX_MESSAGE_CHARS) throw new TeamError(`A memory entry is limited to ${MAX_MESSAGE_CHARS} characters.`, 400);
    return this.store.appendMemory({ topic, author, body, createdAt: Date.now() });
  }

  /**
   * Records a shared file's metadata and posts the message that announces it.
   * The bytes are stored on the hub's disk by the transport before this runs;
   * this owns the rules: canonical recipient, a sane name, a bounded size, and
   * a well-formed sha256. Sending a file needs no approval; receiving it does.
   */
  prepareFile(sender: string, input: { recipient: string; name: string; size: number; sha256: string; fileId?: string }): TeamFile {
    const name = input.name.trim();
    if (!name || name.length > 255 || /[\r\n]/.test(name))
      throw new TeamError('A file name must be 1-255 characters without line breaks.', 400);
    if (!Number.isInteger(input.size) || input.size < 0) throw new TeamError('A file size must be a non-negative integer.', 400);
    if (input.size > MAX_FILE_BYTES) throw new TeamError(`A file is limited to ${Math.floor(MAX_FILE_BYTES / (1024 * 1024))} MB.`, 413);
    if (!/^[0-9a-f]{64}$/.test(input.sha256)) throw new TeamError('A file needs a lowercase hex sha256.', 400);
    const id = input.fileId && input.fileId.trim() ? input.fileId : makeFileId();
    if (id.length > 128 || !/^f_[0-9a-f]{8,}$/.test(id)) throw new TeamError('Invalid file transfer id.', 400);
    const existing = this.store.getFile(id);
    if (existing) {
      if (
        existing.sender !== sender ||
        existing.recipient.toLowerCase() !== input.recipient.trim().toLowerCase() ||
        existing.name !== name ||
        existing.size !== input.size ||
        existing.sha256 !== input.sha256
      )
        throw new TeamError('Transfer id already belongs to a different file.', 409);
      return existing;
    }
    const recipient = this.resolveRecipient(input.recipient);
    return { id, name, size: input.size, sha256: input.sha256, sender, recipient, createdAt: Date.now() };
  }

  fileForMember(member: string, id: string): TeamFile {
    const file = this.store.getFile(id);
    if (!file) throw new TeamError('No such file.', 404);
    if (file.recipient !== member && file.recipient !== GROUP_RECIPIENT && file.sender !== member)
      throw new TeamError('This file is not addressed to you.', 403);
    return file;
  }

  registerFile(sender: string, input: { recipient: string; name: string; size: number; sha256: string; fileId?: string }): TeamMessage {
    const file = this.prepareFile(sender, input);
    const { id, name, recipient } = file;
    return this.store.transaction(() => {
      const existing = this.store.getFile(id);
      if (existing) {
        if (
          existing.sender !== sender ||
          existing.recipient !== recipient ||
          existing.name !== name ||
          existing.size !== input.size ||
          existing.sha256 !== input.sha256
        )
          throw new TeamError('Transfer id already belongs to a different file.', 409);
        const message = this.store.fileMessage(id);
        if (!message) throw new Error('File registration is missing its notification.');
        return message;
      }
      this.store.insertFile(file);
      return this.store.postMessage({
        msgId: makeMessageId(),
        sender,
        recipient,
        kind: 'file',
        body: name,
        fileId: id,
        createdAt: Date.now(),
      });
    });
  }
}
