import { createHash, randomUUID } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { MemoryIndex } from './memory-index.js';
import {
  isCalendarDate,
  MEMORY_INDEX_MAX_BYTES,
  MEMORY_INDEX_MAX_LINES,
  parseMemoryDocument,
  validateMemoryDocument,
  validateMemoryIndex,
  validateMemoryNoteName,
} from './memory-document.js';
import { getMemoryDocumentPath, getMemoryPaths, isMemoryDocumentPath, isMemoryIndexPath, isWithinMemoryRoot } from './memory-paths.js';
import type { ToolEffect } from './tools/registry.js';
import { resolveThroughExistingParents } from './workspace-scope.js';

export const MAX_WRITE_BYTES = 2 * 1024 * 1024;

export function resolveFilePath(source: string, workspaceRoot: string): string {
  if (/^file:/i.test(source)) return fileURLToPath(new URL(source));
  const expanded = source === '~' ? homedir() : source.replace(/^~(?=[/\\])/, () => homedir());
  return resolve(workspaceRoot, expanded);
}

/** Resolves the one target a file tool's permission checks and execution share. */
export function resolveFileTarget(input: Record<string, unknown>, workspaceRoot: string): string | null {
  const source = typeof input.path === 'string' ? input.path.trim() : '';
  if (!source) return null;
  try {
    return resolveThroughExistingParents(resolveFilePath(source, workspaceRoot));
  } catch {
    return null;
  }
}

export function classifyFilePath(source: string, workspaceRoot: string): ToolEffect['data'] {
  let normalized = source;
  try {
    normalized = resolveFilePath(source, workspaceRoot);
  } catch {
    // Invalid paths remain conservatively classified as sensitive.
  }
  const path = normalized.replace(/\\/g, '/').toLowerCase();
  const segments = path.split('/');
  const filename = segments.at(-1) ?? '';
  if (
    segments.includes('.ssh') ||
    segments.includes('.aws') ||
    (segments.includes('.kube') && filename === 'config') ||
    /^\.env(?:\.|$)/.test(filename) ||
    /\.(?:pem|key|p12|pfx)$/.test(filename) ||
    ['credentials', 'cookies', 'login data'].includes(filename)
  )
    return 'secret';
  return 'sensitive';
}

export type TextWriteValidation = { ok: true; sizeBytes: number; sha256: string } | { ok: false; failure: Record<string, unknown> };

/**
 * The single content gate every whole-file or edited-file write passes: size,
 * memory index/document structure, and binary control characters. Callers
 * write only after this returns `ok`.
 */
export function validateTextWrite(content: string, path: string, workspaceRoot: string): TextWriteValidation {
  const sizeBytes = Buffer.byteLength(content, 'utf8');
  if (sizeBytes > MAX_WRITE_BYTES) return { ok: false, failure: { status: 'too_large', sizeBytes, maxBytes: MAX_WRITE_BYTES } };
  if (isMemoryIndexPath(path, workspaceRoot)) {
    const lineCount = content.split(/\r?\n/).length;
    if (sizeBytes > MEMORY_INDEX_MAX_BYTES || lineCount > MEMORY_INDEX_MAX_LINES) {
      return {
        ok: false,
        failure: {
          status: 'memory_index_too_large',
          path: path.slice(0, 512),
          lines: lineCount,
          sizeBytes,
          error: 'Keep the single MEMORY.md index under 200 lines and 25 KB. Move details into topic notes, then update that index.',
        },
      };
    }
    const errors = validateMemoryIndex(content);
    errors.push(...validateMemoryIndexTargets(content, workspaceRoot));
    if (errors.length)
      return {
        ok: false,
        failure: {
          status: 'invalid_memory_index',
          errors,
          error:
            'Keep one concise index with Markdown links to shared user profiles/notes. Move detailed and workspace-specific content into its scoped note.',
        },
      };
  }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(content)) {
    return { ok: false, failure: { status: 'invalid', error: 'content must not contain binary control characters.' } };
  }
  if (isWithinMemoryRoot(path, workspaceRoot) && !isMemoryIndexPath(path, workspaceRoot)) {
    const document = getMemoryDocumentPath(path, workspaceRoot);
    // The shared team scope is a read-only mirror of the hub's log. A file tool
    // must never write it; the only writer is the daemon's materializer, and the
    // only way to record shared memory is team_remember.
    if (document && document.scope.startsWith('team:')) {
      return {
        ok: false,
        failure: {
          status: 'read_only_memory',
          path,
          error: 'Shared team memory is a read-only mirror of the hub log. Record an entry with team_remember, not a file write.',
        },
      };
    }
    if (!document || (document.notePath !== null && !validateMemoryNoteName(document.notePath))) {
      const paths = getMemoryPaths(workspaceRoot);
      return {
        ok: false,
        failure: {
          status: 'invalid_memory_path',
          path,
          error: `Memory files belong at user/preferences.md, user/profile.md, topics/*.md, areas/*.md, self/peers/*.md, team/<team>/*.md, or ${paths.workspaceFile} with descriptive English kebab-case .md names. Maintain your single team identity with team_profile.`,
        },
      };
    }
    const errors = validateMemoryDocument(
      content,
      document.kind === 'profile' ? (document.scope === 'user' ? 'user' : document.scope === 'self' ? undefined : 'project') : undefined,
    );
    if (errors.length)
      return {
        ok: false,
        failure: {
          status: 'invalid_memory_format',
          path,
          errors,
          error: 'Use YAML title/description/updated/type, one matching H1, a summary paragraph, and one durable fact per bullet.',
        },
      };
  }
  return { ok: true, sizeBytes, sha256: createHash('sha256').update(content, 'utf8').digest('hex') };
}

/** Local calendar date; memory notes carry the user's day, not UTC. */
export function todayLocalDate(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

/**
 * Refresh the frontmatter updated line so every native memory write carries an
 * honest date without the agent hand-writing one. Content without frontmatter
 * passes through untouched for the validator to reject.
 */
export function stampMemoryDocumentDate(content: string): string {
  const eol = content.includes('\r\n') ? '\r\n' : '\n';
  const lines = content.split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return content;
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
  if (end < 0) return content;
  const today = todayLocalDate();
  let stamped = false;
  for (let index = 1; index < end; index++) {
    if (/^\s*updated\s*:/.test(lines[index]!)) {
      lines[index] = `updated: ${today}`;
      stamped = true;
    }
  }
  if (!stamped) lines.splice(1, 0, `updated: ${today}`);
  return lines.join(eol);
}

/** Shorten an index signal at a word boundary instead of mid-word. */
export function truncateSignal(text: string, maxLength = 160): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= maxLength) return collapsed;
  const cut = collapsed.lastIndexOf(' ', maxLength);
  return `${collapsed.slice(0, cut > 0 ? cut : maxLength).trimEnd()}…`;
}

/** Temp-file plus rename so a crash cannot leave a half-written target. */
export async function writeTextAtomically(path: string, content: string): Promise<void> {
  const directory = dirname(path);
  const temporaryPath = resolve(directory, `.${basename(path)}.${randomUUID()}.tmp`);
  await mkdir(directory, { recursive: true });
  try {
    await writeFile(temporaryPath, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    await rename(temporaryPath, path);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** Refresh the derived embedding index after a memory write; the file itself is already durable. */
export async function memoryIndexOutcome(
  memoryIndex: MemoryIndex | undefined,
  path: string,
  workspaceRoot: string,
): Promise<Record<string, unknown>> {
  if (!isMemoryDocumentPath(path, workspaceRoot)) return {};
  const outcome: Record<string, unknown> = {};
  if (memoryIndex) {
    try {
      await memoryIndex.reindexPath(path);
      outcome.memoryIndex = 'updated';
    } catch (error) {
      outcome.memoryIndex = 'pending_refresh';
      outcome.memoryIndexError = error instanceof Error ? error.message : String(error);
    }
  }
  try {
    Object.assign(outcome, await ensureMemoryIndexEntry(path, workspaceRoot));
  } catch (error) {
    outcome.memoryIndexEntryError = error instanceof Error ? error.message : String(error);
  }
  return outcome;
}

/**
 * Every user-scope document written by the agent is linked from MEMORY.md.
 * The entry is derived only from the document's own frontmatter, existing index
 * text is never rewritten, and a full or invalid index is reported instead of
 * being modified.
 */
export async function ensureMemoryIndexEntry(path: string, workspaceRoot: string): Promise<Record<string, unknown>> {
  const document = getMemoryDocumentPath(path, workspaceRoot);
  if (!document || document.scope !== 'user') return {};
  const paths = getMemoryPaths(workspaceRoot);
  return withIndexLock(paths.indexFile, async () => {
    let index = '';
    try {
      index = await readFile(paths.indexFile, 'utf8');
    } catch (error) {
      if (!isMissingPath(error)) return { memoryIndexEntryError: error instanceof Error ? error.message : String(error) };
    }
    const linked = new Set<string>();
    for (const match of index.matchAll(/^\s*-\s+\[[^\]]+\]\(([^)\s]+)\)/gm)) {
      const link = match[1]!.replace(/^<|>$/g, '').split('#', 1)[0]!;
      linked.add(normalizePath(resolve(dirname(paths.indexFile), link)));
    }
    if (linked.has(normalizePath(path))) return {};
    let content: string;
    try {
      content = await readFile(path, 'utf8');
    } catch {
      return {};
    }
    const parsed = parseMemoryDocument(content, path, 'user');
    const title =
      parsed.title
        .replace(/[[\]\r\n]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim() || basename(path, '.md');
    const signal = truncateSignal(parsed.description || title);
    const date = isCalendarDate(parsed.updated) ? parsed.updated : todayLocalDate();
    const link = relative(dirname(paths.indexFile), path).replace(/\\/g, '/');
    const updated = index.trim()
      ? `${index.replace(/\s*$/, '')}\n- [${title}](${link}) — ${signal} (${date})\n`
      : `# Memory\n- [${title}](${link}) — ${signal} (${date})\n`;
    if (updated.split(/\r?\n/).length > MEMORY_INDEX_MAX_LINES || Buffer.byteLength(updated, 'utf8') > MEMORY_INDEX_MAX_BYTES)
      return { memoryIndexEntry: 'skipped_index_full' };
    const validation = validateTextWrite(updated, paths.indexFile, workspaceRoot);
    if (!validation.ok) return { memoryIndexEntry: 'skipped_invalid_index' };
    await writeTextAtomically(paths.indexFile, updated);
    return { memoryIndexEntry: 'added' };
  });
}

const indexLockChains = new Map<string, Promise<void>>();

/**
 * Serialize concurrent MEMORY.md read-modify-write cycles per index file, so
 * parallel sessions appending entries cannot silently lose each other's lines.
 */
async function withIndexLock<T>(indexFile: string, task: () => Promise<T>): Promise<T> {
  const previous = indexLockChains.get(indexFile);
  let release: () => void = () => {};
  const turn = new Promise<void>((resolve) => {
    release = resolve;
  });
  indexLockChains.set(
    indexFile,
    (previous ?? Promise.resolve()).then(() => turn),
  );
  if (previous) await previous;
  try {
    return await task();
  } finally {
    release();
  }
}

function normalizePath(path: string): string {
  const normalized = resolve(path);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

export interface TextDiffStat {
  addedLines: number;
  removedLines: number;
}

const MAX_DIFF_INPUT_LINES = 4000;
const MAX_DIFF_COMPLEXITY = 8000;
const MAX_DIFF_TRACE = 3000;

/**
 * A small Myers line diff for write transcripts: exact added/removed stats.
 * Returns null when either side is too large to diff safely; callers then
 * fall back to plain line counts.
 */
export function diffStat(oldText: string, newText: string): TextDiffStat | null {
  const oldLines = oldText.split(/\r?\n/);
  const newLines = newText.split(/\r?\n/);
  if (oldLines.length > MAX_DIFF_INPUT_LINES || newLines.length > MAX_DIFF_INPUT_LINES) return null;
  if (oldLines.length + newLines.length > MAX_DIFF_COMPLEXITY) return null;
  const ops = myersOps(oldLines, newLines);
  if (ops === null) return null;
  let addedLines = 0;
  let removedLines = 0;
  for (const op of ops) {
    if (op.type === 'insert') addedLines++;
    else if (op.type === 'delete') removedLines++;
  }
  return { addedLines, removedLines };
}

type DiffOp = { type: 'equal' | 'delete' | 'insert'; line: string };

function myersOps(a: string[], b: string[]): DiffOp[] | null {
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (suffix < a.length - prefix && suffix < b.length - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) {
    suffix++;
  }
  const head = a.slice(0, prefix).map((line) => ({ type: 'equal' as const, line }));
  const tail = a.slice(a.length - suffix).map((line) => ({ type: 'equal' as const, line }));
  const middle = myersMiddle(a.slice(prefix, a.length - suffix), b.slice(prefix, b.length - suffix));
  if (middle === null) return null;
  return [...head, ...middle, ...tail];
}

function myersMiddle(a: string[], b: string[]): DiffOp[] | null {
  const n = a.length;
  const m = b.length;
  if (n === 0) return b.map((line) => ({ type: 'insert' as const, line }));
  if (m === 0) return a.map((line) => ({ type: 'delete' as const, line }));
  const max = n + m;
  const missing = Number.NEGATIVE_INFINITY;
  let v = new Map<number, number>([[1, 0]]);
  const trace: Array<Map<number, number>> = [];
  for (let d = 0; d <= max; d++) {
    const previous = new Map(v);
    const snapshot = new Map<number, number>();
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && (previous.get(k - 1) ?? missing) < (previous.get(k + 1) ?? missing))) {
        x = previous.get(k + 1) ?? 0;
      } else {
        x = (previous.get(k - 1) ?? -1) + 1;
      }
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      snapshot.set(k, x);
      if (x >= n && y >= m) {
        trace.push(snapshot);
        return backtrackDiff(trace, a, b);
      }
    }
    v = snapshot;
    trace.push(snapshot);
    if (trace.length > MAX_DIFF_TRACE) return null;
  }
  return null;
}

function backtrackDiff(trace: Array<Map<number, number>>, a: string[], b: string[]): DiffOp[] {
  const missing = Number.NEGATIVE_INFINITY;
  const ops: DiffOp[] = [];
  let x = a.length;
  let y = b.length;
  for (let d = trace.length - 1; d >= 1; d--) {
    const v = trace[d - 1]!;
    const k = x - y;
    const down = k === -d || (k !== d && (v.get(k - 1) ?? missing) < (v.get(k + 1) ?? missing));
    const previousK = down ? k + 1 : k - 1;
    const previousX = v.get(previousK) ?? 0;
    const previousY = previousX - previousK;
    while (x > previousX && y > previousY) {
      x--;
      y--;
      ops.push({ type: 'equal', line: a[x]! });
    }
    if (x === previousX) {
      y--;
      ops.push({ type: 'insert', line: b[y]! });
    } else {
      x--;
      ops.push({ type: 'delete', line: a[x]! });
    }
  }
  while (x > 0 && y > 0) {
    x--;
    y--;
    ops.push({ type: 'equal', line: a[x]! });
  }
  return ops.reverse();
}

function isMissingPath(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

function validateMemoryIndexTargets(content: string, workspaceRoot: string): string[] {
  const root = dirname(getMemoryPaths(workspaceRoot).indexFile);
  const errors: string[] = [];
  for (const match of content.matchAll(/^\s*-\s+\[[^\]]+\]\(([^)\s]+)\)/gm)) {
    const link = match[1]!.replace(/^<|>$/g, '');
    const target = resolve(root, link.split('#', 1)[0]!);
    const line = content.slice(0, match.index ?? 0).split(/\r?\n/).length;
    if (!isMemoryDocumentPath(target, workspaceRoot)) {
      errors.push(`Line ${line}: index links must resolve to an active shared-user memory document.`);
      continue;
    }
    try {
      const details = lstatSync(target);
      if (!details.isFile() || details.isSymbolicLink()) errors.push(`Line ${line}: memory index target must be a regular Markdown file.`);
    } catch {
      errors.push(`Line ${line}: memory index target does not exist: ${link}`);
    }
  }
  return errors;
}
