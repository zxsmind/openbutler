import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, readFileSync, linkSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import type { ModelMessage } from 'ai';
import {
  ensureSessionAttachmentsDirectory,
  sessionAttachmentsDirectory,
  sessionDirectory,
  sessionsDirectory,
  SESSION_ID,
} from './session-paths.js';
import { decodeBase64, decodeDataUrl, imageTypeFromBytes, MAX_IMAGE_BYTES } from './image-data.js';
import { isWithinPhysicalDirectory } from './workspace-scope.js';

export interface FileAttachment {
  id: string;
  path: string;
  name: string;
  mediaType: string;
  sizeBytes: number;
  sha256: string;
}

const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const attachmentRoot = sessionAttachmentsDirectory;

/** Immutable, content-addressed files. A notification receipt never deletes its attachment. */
export function storeAttachment(
  sessionId: string,
  bytes: Uint8Array,
  name = 'attachment',
  declaredType = 'application/octet-stream',
): FileAttachment {
  if (!bytes.length || bytes.length > MAX_ATTACHMENT_BYTES) throw new Error('Attachment must contain between 1 byte and 50 MB.');
  const data = Buffer.from(bytes);
  const imageType = imageTypeFromBytes(data);
  if (declaredType.startsWith('image/') && imageType !== declaredType)
    throw new Error('The attachment image type does not match its data.');
  if (imageType && data.length > MAX_IMAGE_BYTES) throw new Error('Images must be 5 MB or smaller.');
  const mediaType = imageType ?? declaredType;
  const safeName =
    basename(name.replace(/\\/g, '/'))
      .replace(/[\x00-\x1f\x7f]/g, '_')
      .slice(0, 200) || 'attachment';
  const extension = imageType
    ? `.${imageType === 'image/jpeg' ? 'jpg' : imageType.slice(6)}`
    : /^\.[a-z0-9]{1,10}$/i.test(extname(safeName))
      ? extname(safeName).toLowerCase()
      : '.bin';
  const sha256 = digest(data);
  const root = ensureSessionAttachmentsDirectory(sessionId);
  const path = join(root, `${sha256}${extension}`);
  const temporary = join(root, `.${randomUUID()}.tmp`);
  writeFileSync(temporary, data, { flag: 'wx', mode: 0o600 });
  try {
    try {
      linkSync(temporary, path);
    } catch (error) {
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST')) throw error;
    }
    verifyAttachmentPath(path);
  } finally {
    unlinkSync(temporary);
  }
  return { id: sha256, path, name: safeName, mediaType, sizeBytes: data.length, sha256 };
}

/** Only a regular, physically contained, hash-verified stored file gets read pre-authorization. */
export function isStoredAttachmentPath(path: string): boolean {
  try {
    verifyAttachmentPath(path);
    return true;
  } catch {
    return false;
  }
}

export function verifyAttachmentPath(path: string): void {
  const sessionId = basename(dirname(dirname(path)));
  if (
    !SESSION_ID.test(sessionId) ||
    !isWithinPhysicalDirectory(sessionDirectory(sessionId), sessionsDirectory()) ||
    lstatSync(sessionDirectory(sessionId)).isSymbolicLink()
  )
    throw new Error('Invalid attachment session.');
  const expected = /^([0-9a-f]{64})\.[a-z0-9]{1,10}$/i.exec(basename(path))?.[1];
  if (
    !expected ||
    resolve(path) !== resolve(join(attachmentRoot(sessionId), basename(path))) ||
    !isWithinPhysicalDirectory(path, sessionDirectory(sessionId)) ||
    lstatSync(attachmentRoot(sessionId)).isSymbolicLink()
  )
    throw new Error('Invalid attachment file reference.');
  const details = lstatSync(path);
  if (!details.isFile() || details.isSymbolicLink() || details.size > MAX_ATTACHMENT_BYTES || digest(readFileSync(path)) !== expected)
    throw new Error('The stored attachment failed its integrity check.');
}

export function isAttachmentPath(path: string): boolean {
  const sessionId = basename(dirname(dirname(path)));
  return SESSION_ID.test(sessionId) && resolve(path) === resolve(join(attachmentRoot(sessionId), basename(path)));
}

export function attachmentReferences(attachments: readonly FileAttachment[]): string {
  let images = 0;
  let files = 0;
  return attachments
    .map(
      (attachment) =>
        `[${attachment.mediaType.startsWith('image/') ? `image#${++images}` : `file#${++files}`}=${JSON.stringify(attachment.path)}]`,
    )
    .join('\n');
}

/** Legacy inline input becomes an on-demand file reference, including after session restore/compaction. */
export function materializeIncomingAttachments(messages: ModelMessage[], sessionId?: string): ModelMessage[] {
  let changed = false;
  const result = messages.map((message): ModelMessage => {
    if (message.role !== 'user' || !Array.isArray(message.content) || message.providerOptions?.openbutler?.explicitToolMedia === true)
      return message;
    let images = 0;
    let files = 0;
    let messageChanged = false;
    const content = message.content.map((part) => {
      if (part.type !== 'image' && part.type !== 'file') return part;
      const value = part.type === 'image' ? part.image : part.data;
      const mediaType = part.type === 'image' ? (part.mediaType ?? 'image/png') : part.mediaType;
      const label = mediaType.startsWith('image/') ? `image#${++images}` : `file#${++files}`;
      changed = messageChanged = true;
      try {
        if (value instanceof URL || (typeof value === 'string' && /^https?:\/\//i.test(value)))
          return { type: 'text' as const, text: `[${label}=${JSON.stringify(String(value))}]` };
        const bytes =
          typeof value === 'string'
            ? /^data:/i.test(value)
              ? decodeDataUrl(value)
              : decodeBase64(value, MAX_ATTACHMENT_BYTES)
            : value instanceof ArrayBuffer
              ? new Uint8Array(value)
              : value;
        if (!sessionId) throw new Error('No session is bound to this attachment.');
        const attachment = storeAttachment(sessionId, bytes, part.type === 'file' ? (part.filename ?? label) : label, mediaType);
        return { type: 'text' as const, text: `[${label}=${JSON.stringify(attachment.path)}]` };
      } catch (error) {
        return {
          type: 'text' as const,
          text: `[${label}: attachment unavailable: ${error instanceof Error ? error.message : String(error)}]`,
        };
      }
    });
    return messageChanged ? { ...message, content } : message;
  });
  return changed ? result : messages;
}
