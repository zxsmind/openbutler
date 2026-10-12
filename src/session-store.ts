import { randomUUID } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { ModelMessage } from 'ai';
import { getDataPath } from './paths.js';
import { appendTranscriptArchiveReference, repairQueuedMessageOrder, retireCoveredToolPreviews } from './conversation.js';

export type SessionEntry =
  | {
      kind: 'user';
      text: string;
      workspaceRoot?: string;
      imageCount?: number;
      source?: 'terminal' | 'telegram' | 'owner-inbox' | 'background';
      eventId?: string;
    }
  | { kind: 'assistant' | 'notice'; text: string }
  | { kind: 'reasoning'; text: string }
  | { kind: 'tool'; command: string; result: string; running?: boolean; preparing?: boolean; tool?: string; session?: string };

export interface SessionFileInfo {
  id: string;
  path: string;
  modifiedAt: number;
  sizeBytes: number;
}

export interface SavedSession {
  version: 1;
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  providerId: string;
  modelId: string;
  /** Canonical workspace that supplied this session's tool and memory scope. */
  workspaceRoot?: string;
  contextTokens?: number;
  /** Byte estimate of the last provider-measured input, used only for subsequent growth. */
  contextEstimateTokens?: number;
  contextWindowTokens?: number;
  contextGrowthTokens?: number;
  /**
   * Denormalised display fields, written so the picker never has to read `entries`.
   * Absent on sessions saved before this field existed; listing falls back to a full parse
   * for those and they gain the fields the next time they are saved.
   */
  hasUserMessage?: boolean;
  preview?: string;
  /**
   * Denormalised cross-session context fields, written so the session registry and the
   * "Recent sessions" block never parse `entries`. Absent on sessions saved before these
   * fields existed; the block degrades to title and preview until the session is saved again.
   */
  firstUserMessage?: string;
  lastAssistantMessage?: string;
  entries: SessionEntry[];
  conversation: ModelMessage[];
  /** Full transcript retained across compaction; older sessions fall back to `conversation`. */
  conversationArchive?: ModelMessage[];
}

export interface SessionSummary {
  id: string;
  title: string;
  preview: string;
  updatedAt: string;
  providerId: string;
  modelId: string;
  workspaceRoot?: string;
}

const SESSION_DIR = getDataPath('sessions');
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function createSession(providerId: string, modelId: string, contextWindowTokens?: number, workspaceRoot?: string): SavedSession {
  const now = new Date().toISOString();
  return {
    version: 1,
    id: randomUUID(),
    title: 'New session',
    createdAt: now,
    updatedAt: now,
    providerId,
    modelId,
    ...(workspaceRoot ? { workspaceRoot: resolve(workspaceRoot) } : {}),
    ...(contextWindowTokens !== undefined ? { contextWindowTokens } : {}),
    entries: [],
    conversation: [],
  };
}

export function sessionTitle(entries: readonly SessionEntry[]): string {
  const firstUser = entries.find((entry) => entry.kind === 'user');
  if (!firstUser || firstUser.kind !== 'user') return 'New session';
  const title = firstUser.text.replace(/\s+/g, ' ').trim();
  return title ? title.slice(0, 80) : firstUser.imageCount ? 'Image chat' : 'New session';
}

/** Session files on disk with their metadata, oldest first; used by explicit pruning only. */
export function listSessionFiles(): SessionFileInfo[] {
  let names: string[];
  try {
    names = readdirSync(SESSION_DIR);
  } catch (error) {
    if (isMissingFile(error)) return [];
    throw error;
  }

  const files: SessionFileInfo[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const id = name.slice(0, -5);
    if (!SESSION_ID.test(id)) continue;
    try {
      const details = statSync(join(SESSION_DIR, name));
      if (!details.isFile()) continue;
      files.push({ id, path: join(SESSION_DIR, name), modifiedAt: details.mtimeMs, sizeBytes: details.size });
    } catch {
      // A file that vanished or cannot be stat'ed is not a pruning candidate.
    }
  }
  return files.sort((left, right) => left.modifiedAt - right.modifiedAt || left.id.localeCompare(right.id));
}

export function listSavedSessions(workspaceRoot?: string | null): SessionSummary[] {
  let names: string[];
  try {
    names = readdirSync(SESSION_DIR);
  } catch (error) {
    if (isMissingFile(error)) return [];
    throw error;
  }

  const sessions: SessionSummary[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const id = name.slice(0, -5);
    if (!SESSION_ID.test(id)) continue;
    try {
      const session = readSessionHeader(join(SESSION_DIR, name), id);
      if (!session || session.id !== id || !session.hasUserMessage) continue;
      if (workspaceRoot === null && session.workspaceRoot) continue;
      if (typeof workspaceRoot === 'string' && (!session.workspaceRoot || !samePath(session.workspaceRoot, workspaceRoot))) continue;
      sessions.push({
        id,
        title: session.title,
        preview: session.preview ?? '',
        updatedAt: session.updatedAt,
        providerId: session.providerId,
        modelId: session.modelId,
        ...(session.workspaceRoot ? { workspaceRoot: session.workspaceRoot } : {}),
      });
    } catch {
      // Ignore an incomplete or unreadable file so one damaged session cannot block the picker.
    }
  }

  return sessions.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

/**
 * A session file stores its display entries plus the model transcript and, once a compaction
 * has happened, the whole pre-compaction archive. A tool result alone can be 80 KB, so those two
 * fields are nearly all of the bytes and the picker needs none of them. Listing therefore reads
 * only the part of the file in front of them.
 *
 * The cutoff is guessed and then verified: the truncated prefix is only accepted if it parses as a
 * session whose id matches the file name. A string inside an entry that happens to contain
 * `\n  "conversation":` cannot pass that check, so the fallback to a full parse is what keeps this
 * correct rather than merely fast.
 */
/**
 * The display fields the picker, the session registry, and the "Recent sessions" block show.
 * `entries` is absent: none of them read it. The message previews are denormalised onto the saved
 * session so this stays true — reading them from `entries` would otherwise mean parsing every
 * session on every listing or context build.
 */
export interface StoredSessionHeader {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  providerId: string;
  modelId: string;
  workspaceRoot?: string;
  hasUserMessage: boolean;
  preview: string;
  firstUserMessage: string;
  lastAssistantMessage: string;
}

function sessionPreview(entries: readonly SessionEntry[]): string {
  const lastUser = entries.findLast((entry) => entry.kind === 'user');
  if (lastUser?.kind !== 'user') return '';
  return lastUser.text.replace(/\s+/g, ' ').trim().slice(0, 120) || (lastUser.imageCount ? '[Image attached #1]' : '');
}

function firstUserMessageText(entries: readonly SessionEntry[]): string {
  const firstUser = entries.find((entry) => entry.kind === 'user');
  if (firstUser?.kind !== 'user') return '';
  return firstUser.text.replace(/\s+/g, ' ').trim().slice(0, 240) || (firstUser.imageCount ? '[Image attached]' : '');
}

function lastAssistantMessageText(entries: readonly SessionEntry[]): string {
  const lastAssistant = entries.findLast((entry) => entry.kind === 'assistant');
  if (lastAssistant?.kind !== 'assistant') return '';
  return lastAssistant.text.replace(/\s+/g, ' ').trim().slice(0, 240);
}

/**
 * Reads a session's display fields without reading its entries.
 *
 * A saved session is pretty-printed with two-space indentation and every header field is
 * serialised before `entries`, so the header alone is a few hundred bytes at the front of the file.
 * A JSON string can never contain a real newline, so `\n  "entries":` occurs only at a structural
 * position: cutting there and closing the object cannot produce a valid parse by accident. That
 * makes the cutoff checkable rather than merely plausible — anything unexpected falls through to a
 * full parse, which is what keeps this correct and not just fast.
 *
 * Sessions saved before `hasUserMessage` and `preview` existed carry no header-only summary, so
 * they take the full read and are rewritten with both fields the next time they are saved.
 * `firstUserMessage` and `lastAssistantMessage` are read when present but never trigger a full
 * parse on their own: a multi-megabyte session would make that fallback far more expensive than
 * the previews it would add, so the registry degrades to title and preview until the next save.
 */
const HEADER_WINDOW_BYTES = 8 * 1024;

export function readSessionHeader(path: string, id: string): StoredSessionHeader | null {
  const head = readPrefix(path, HEADER_WINDOW_BYTES);
  if (head === null) return null;
  const boundary = /\n {2}"entries":/.exec(head.text);
  if (boundary) {
    // Pretty-printed JSON puts the separating comma at the end of the prefix, so it has to go
    // before the closing brace is added back.
    const parsed = tryParseHeader(`${head.text.slice(0, boundary.index).replace(/[\s,]+$/, '')}\n}`, id);
    if (parsed) return parsed;
  } else if (head.complete) {
    // The whole file fits in the window and carries no `entries` marker, so it is already complete.
    return fullSessionHeader(head.text);
  }
  return fullSessionHeader(readFileSync(path, 'utf8'));
}

/**
 * Reads at most `bytes` from the front of a file. Session headers are a few hundred bytes.
 *
 * `complete` reports that the read reached end of file. It cannot be inferred from the text length,
 * because the prefix is measured in bytes while the string is measured in characters and a multibyte
 * (e.g. CJK) header decodes to fewer of them.
 */
function readPrefix(path: string, bytes: number): { text: string; complete: boolean } | null {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, 'r');
    const buffer = Buffer.allocUnsafe(bytes);
    const read = readSync(descriptor, buffer, 0, bytes, 0);
    return { text: buffer.toString('utf8', 0, read), complete: read < bytes };
  } catch {
    return null;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function fullSessionHeader(text: string): StoredSessionHeader | null {
  const full = parseSession(text);
  if (!full) return null;
  return {
    id: full.id,
    title: full.title,
    createdAt: full.createdAt,
    updatedAt: full.updatedAt,
    providerId: full.providerId,
    modelId: full.modelId,
    ...(full.workspaceRoot ? { workspaceRoot: full.workspaceRoot } : {}),
    hasUserMessage: full.hasUserMessage ?? full.entries.some((entry) => entry.kind === 'user'),
    preview: full.preview ?? sessionPreview(full.entries),
    firstUserMessage: full.firstUserMessage ?? firstUserMessageText(full.entries),
    lastAssistantMessage: full.lastAssistantMessage ?? lastAssistantMessageText(full.entries),
  };
}

function tryParseHeader(text: string, id: string): StoredSessionHeader | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(value) || value.version !== 1 || value.id !== id) return null;
  if (typeof value.title !== 'string' || typeof value.updatedAt !== 'string' || typeof value.createdAt !== 'string') return null;
  if (typeof value.providerId !== 'string' || typeof value.modelId !== 'string') return null;
  // A session without both denormalised fields predates them, so it is read in full instead.
  if (value.hasUserMessage !== true || typeof value.preview !== 'string') return null;
  return {
    id,
    title: value.title,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    providerId: value.providerId,
    modelId: value.modelId,
    ...(typeof value.workspaceRoot === 'string' ? { workspaceRoot: value.workspaceRoot } : {}),
    hasUserMessage: true,
    preview: value.preview,
    firstUserMessage: typeof value.firstUserMessage === 'string' ? value.firstUserMessage : '',
    lastAssistantMessage: typeof value.lastAssistantMessage === 'string' ? value.lastAssistantMessage : '',
  };
}

export function loadSavedSession(id: string, workspaceRoot?: string | null): SavedSession | null {
  if (!SESSION_ID.test(id)) throw new Error('Invalid session id.');
  let text: string;
  try {
    text = readFileSync(join(SESSION_DIR, `${id}.json`), 'utf8');
  } catch (error) {
    if (isMissingFile(error)) return null;
    throw error;
  }
  const session = parseSession(text);
  if (!session || session.id !== id) throw new Error('This session file is invalid or unsupported.');
  if (workspaceRoot === null && session.workspaceRoot) return null;
  if (typeof workspaceRoot === 'string' && (!session.workspaceRoot || !samePath(session.workspaceRoot, workspaceRoot))) return null;
  const ordered = repairQueuedMessageOrder(session.conversation);
  const projected = retireCoveredToolPreviews(ordered);
  const restored: SavedSession = {
    ...session,
    conversation: projected,
    ...(session.conversationArchive ? { conversationArchive: repairQueuedMessageOrder(session.conversationArchive) } : {}),
    entries: session.entries.map((entry) => {
      if (entry.kind !== 'tool') return entry;
      if (entry.running) return { ...entry, running: false, result: 'Execution was interrupted before the result was saved.' };
      if (entry.preparing) return { ...entry, preparing: false, result: 'The tool call was not executed.' };
      return entry;
    }),
  };
  if (projected !== ordered) {
    restored.conversationArchive ??= ordered;
    const checkpoint = restored.conversation[0];
    if (checkpoint?.role === 'assistant' && typeof checkpoint.content === 'string') {
      restored.conversation = [
        { ...checkpoint, content: appendTranscriptArchiveReference(checkpoint.content, join(SESSION_DIR, session.id + '.json')) },
        ...restored.conversation.slice(1),
      ];
    }
    delete restored.contextTokens;
    delete restored.contextEstimateTokens;
    delete restored.contextGrowthTokens;
  }
  return restored;
}

export function saveSession(session: SavedSession): SavedSession {
  if (!isSavedSession(session)) throw new Error('Cannot save an invalid session.');
  if (!session.entries.some((entry) => entry.kind === 'user')) return session;
  // Built field by field rather than spread, because the listing reads a header from the front of
  // the file and needs `hasUserMessage` and `preview` to be serialised before `entries`. A spread
  // would append any key the incoming session does not already carry to the very end of the object,
  // which is exactly where they must not be.
  const saved: SavedSession = {
    version: 1,
    id: session.id,
    title: session.title === 'New session' ? sessionTitle(session.entries) : session.title,
    createdAt: session.createdAt,
    updatedAt: new Date().toISOString(),
    providerId: session.providerId,
    modelId: session.modelId,
    ...(session.workspaceRoot === undefined ? {} : { workspaceRoot: session.workspaceRoot }),
    ...(session.contextTokens === undefined ? {} : { contextTokens: session.contextTokens }),
    ...(session.contextEstimateTokens === undefined ? {} : { contextEstimateTokens: session.contextEstimateTokens }),
    ...(session.contextWindowTokens === undefined ? {} : { contextWindowTokens: session.contextWindowTokens }),
    ...(session.contextGrowthTokens === undefined ? {} : { contextGrowthTokens: session.contextGrowthTokens }),
    hasUserMessage: true,
    preview: sessionPreview(session.entries),
    firstUserMessage: firstUserMessageText(session.entries),
    lastAssistantMessage: lastAssistantMessageText(session.entries),
    entries: session.entries,
    conversation: session.conversation,
    ...(session.conversationArchive === undefined ? {} : { conversationArchive: session.conversationArchive }),
  };
  mkdirSync(SESSION_DIR, { recursive: true });
  const path = join(SESSION_DIR, `${session.id}.json`);
  const temporaryPath = `${path}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(saved, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  renameSync(temporaryPath, path);
  return saved;
}

function parseSession(text: string): SavedSession | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  return isSavedSession(value) ? value : null;
}

function isSavedSession(value: unknown): value is SavedSession {
  if (!isRecord(value)) return false;
  return (
    value.version === 1 &&
    typeof value.id === 'string' &&
    SESSION_ID.test(value.id) &&
    typeof value.title === 'string' &&
    typeof value.createdAt === 'string' &&
    typeof value.updatedAt === 'string' &&
    typeof value.providerId === 'string' &&
    typeof value.modelId === 'string' &&
    (value.workspaceRoot === undefined || typeof value.workspaceRoot === 'string') &&
    (value.contextTokens === undefined ||
      (typeof value.contextTokens === 'number' && Number.isSafeInteger(value.contextTokens) && value.contextTokens >= 0)) &&
    (value.contextEstimateTokens === undefined ||
      (typeof value.contextEstimateTokens === 'number' &&
        Number.isSafeInteger(value.contextEstimateTokens) &&
        value.contextEstimateTokens >= 0)) &&
    (value.contextWindowTokens === undefined ||
      (typeof value.contextWindowTokens === 'number' &&
        Number.isSafeInteger(value.contextWindowTokens) &&
        value.contextWindowTokens > 0)) &&
    (value.contextGrowthTokens === undefined ||
      (typeof value.contextGrowthTokens === 'number' &&
        Number.isSafeInteger(value.contextGrowthTokens) &&
        value.contextGrowthTokens >= 0)) &&
    Array.isArray(value.entries) &&
    value.entries.every(isSessionEntry) &&
    Array.isArray(value.conversation) &&
    value.conversation.every(isModelMessage) &&
    (value.conversationArchive === undefined ||
      (Array.isArray(value.conversationArchive) && value.conversationArchive.every(isModelMessage))) &&
    (value.firstUserMessage === undefined || typeof value.firstUserMessage === 'string') &&
    (value.lastAssistantMessage === undefined || typeof value.lastAssistantMessage === 'string')
  );
}

function isSessionEntry(value: unknown): value is SessionEntry {
  if (!isRecord(value)) return false;
  if (value.kind === 'tool')
    return (
      typeof value.command === 'string' &&
      typeof value.result === 'string' &&
      (value.running === undefined || typeof value.running === 'boolean') &&
      (value.preparing === undefined || typeof value.preparing === 'boolean') &&
      (value.tool === undefined || typeof value.tool === 'string') &&
      (value.session === undefined || typeof value.session === 'string')
    );
  if (value.kind === 'user')
    return (
      typeof value.text === 'string' &&
      (value.source === undefined || ['terminal', 'telegram', 'background'].includes(String(value.source))) &&
      (value.eventId === undefined || typeof value.eventId === 'string') &&
      (value.workspaceRoot === undefined || typeof value.workspaceRoot === 'string') &&
      (value.imageCount === undefined ||
        (typeof value.imageCount === 'number' && Number.isSafeInteger(value.imageCount) && value.imageCount > 0))
    );
  return ['assistant', 'notice', 'reasoning'].includes(String(value.kind)) && typeof value.text === 'string';
}

function isModelMessage(value: unknown): value is ModelMessage {
  return isRecord(value) && ['system', 'developer', 'user', 'assistant', 'tool'].includes(String(value.role)) && 'content' in value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isMissingFile(error: unknown): boolean {
  return isRecord(error) && error.code === 'ENOENT';
}

export function samePath(left: string, right: string): boolean {
  const leftPath = resolve(left);
  const rightPath = resolve(right);
  return process.platform === 'win32'
    ? leftPath.toLocaleLowerCase('en-US') === rightPath.toLocaleLowerCase('en-US')
    : leftPath === rightPath;
}
