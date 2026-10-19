import { existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import {
  classifyFilePath,
  diffStat,
  MAX_WRITE_BYTES,
  memoryIndexOutcome,
  resolveFileTarget,
  resolveFilePath,
  stampMemoryDocumentDate,
  validateTextWrite,
  writeTextAtomically,
} from '../file-write-core.js';
import type { MemoryIndex } from '../memory-index.js';
import { classifyHostOwnedPath } from '../host-owned-paths.js';
import { isMemoryDocumentPath, isMemoryIndexPath } from '../memory-paths.js';
import { inspectTextIntegrity } from '../text-integrity.js';
import type { ToolDefinition, ToolEffect } from './registry.js';
import { classifyTrustedPath, trustedRootsFor } from '../workspace-scope.js';

const editEffect: ToolEffect = {
  change: 'modify',
  data: 'sensitive',
  network: 'none',
  reversible: 'compensating',
  outbound: 'none',
};

type Replacement = { old: string; new: string; occurrence?: number };

/** Every position `needle` occurs at, in file order. */
function matchPositions(content: string, needle: string): number[] {
  const positions: number[] = [];
  let found = content.indexOf(needle);
  while (found !== -1) {
    positions.push(found);
    found = content.indexOf(needle, found + needle.length);
  }
  return positions;
}

function parseReplacements(value: unknown): { ok: true; edits: Replacement[] } | { ok: false; error: string } {
  if (!Array.isArray(value) || value.length === 0) return { ok: false, error: 'edits must be a non-empty array.' };
  if (value.length > 100) return { ok: false, error: 'edits holds at most 100 replacements.' };
  const edits: Replacement[] = [];
  for (let index = 0; index < value.length; index++) {
    const raw = value[index];
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      return { ok: false, error: `edits[${index}] must be an object with old and new.` };
    }
    const record = raw as Record<string, unknown>;
    const old = typeof record.old === 'string' ? record.old : null;
    const replacement = typeof record.new === 'string' ? record.new : null;
    if (!old) return { ok: false, error: `edits[${index}].old must be a non-empty string.` };
    if (replacement === null) return { ok: false, error: `edits[${index}].new must be a string.` };
    const occurrence = record.occurrence;
    if (occurrence !== undefined && (!Number.isSafeInteger(occurrence) || Number(occurrence) < 1 || Number(occurrence) > 100_000)) {
      return { ok: false, error: `edits[${index}].occurrence must be a positive 1-based match number.` };
    }
    edits.push({ old, new: replacement, ...(occurrence === undefined ? {} : { occurrence: Number(occurrence) }) });
  }
  return { ok: true, edits };
}

/** Replaces one exact occurrence inside an existing UTF-8 text file. */
export function createEditTool(workspaceRoot = process.cwd(), memoryIndex?: MemoryIndex): ToolDefinition {
  return {
    providerId: 'host',
    name: 'file_edit',
    description:
      'Edit an existing local UTF-8 text file without rewriting it whole. Three modes, exactly one per call. (1) One replacement: `old` and `new`; `old` must match the current content exactly, including whitespace. (2) Several replacements in one atomic write: `edits: [{old, new, occurrence?}]`, all matched against the original content; an edit whose `old` matches more than one place must name `occurrence`, and overlapping edits are refused, so either every edit lands or the file is untouched. (3) A line range: `startLine`, optional `endLine`, and `newText` (1-based, inclusive) replaces those whole lines without reproducing their text. Every mode reports the edited line(s), line counts, added/removed lines, and the sha256 of the written text. Prefer file_edit over file_write for targeted changes; use file_write only to create a file or replace it completely. Workspace writes follow the active permission mode. Ranite-owned paths (scratch, memory, settings) are pre-authorized and keep the same structure validation as file_write.',
    maxInputChars: MAX_WRITE_BYTES * 3 + 100_000,
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute or workspace-relative path of the existing file to edit.' },
        old: { type: 'string', description: 'Mode 1: exact text to find in the current file content, including whitespace.' },
        new: { type: 'string', description: 'Mode 1: replacement text; an empty string deletes the matched text.' },
        occurrence: {
          type: 'integer',
          minimum: 1,
          description: 'Mode 1: which 1-based occurrence of `old` to replace; defaults to the first.',
        },
        edits: {
          type: 'array',
          minItems: 1,
          maxItems: 100,
          description:
            'Mode 2: replacements applied together. Each old is matched against the original content, and an old that appears more than once needs its own occurrence.',
          items: {
            type: 'object',
            properties: {
              old: { type: 'string', description: 'Exact text to find.' },
              new: { type: 'string', description: 'Replacement text; an empty string deletes it.' },
              occurrence: { type: 'integer', minimum: 1, description: 'Which 1-based match, when old is ambiguous.' },
            },
            required: ['old', 'new'],
            additionalProperties: false,
          },
        },
        startLine: { type: 'integer', minimum: 1, description: 'Mode 3: first line to replace, 1-based.' },
        endLine: {
          type: 'integer',
          minimum: 1,
          description: 'Mode 3: last line to replace, 1-based and inclusive; defaults to startLine.',
        },
        anchor: {
          type: 'string',
          description:
            'Mode 3, required: the exact current text of the startLine, without its line ending. It is checked before writing, so a stale line number cannot replace the wrong lines.',
        },
        newText: { type: 'string', description: 'Mode 3: text that replaces those lines; empty deletes them.' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    effect: editEffect,
    resolveTarget: (input) => resolveFileTarget(input, workspaceRoot),
    workspaceScope: (input, target) => {
      const source = typeof input.path === 'string' ? input.path.trim() : '';
      if (!source) return 'unknown';
      try {
        return classifyTrustedPath(target ?? resolveFilePath(source, workspaceRoot), trustedRootsFor(workspaceRoot));
      } catch {
        return 'unknown';
      }
    },
    hostPreAuthorized: (input, target) => {
      const source = target ?? (typeof input.path === 'string' ? input.path : '');
      const kind = classifyHostOwnedPath(source, workspaceRoot);
      // Spilled tool output is host-written generated data: readable, never a
      // place for the agent to write.
      return kind !== null && kind !== 'tool-output';
    },
    assess: (input, target) => {
      const path = target ?? (typeof input.path === 'string' ? input.path : workspaceRoot);
      return {
        ...editEffect,
        change: existsSync(path) ? 'modify' : 'create',
        data: classifyFilePath(path, workspaceRoot),
      };
    },
    execute: async (input, signal, context) => {
      const source = typeof input.path === 'string' ? input.path.trim() : '';
      if (!source) return { status: 'invalid', error: 'path must be a non-empty string.' };

      const single = typeof input.old === 'string' || typeof input.new === 'string' || input.occurrence !== undefined;
      const ranged = input.startLine !== undefined || input.endLine !== undefined || input.newText !== undefined;
      const multi = input.edits !== undefined;
      if ([single, ranged, multi].filter(Boolean).length !== 1) {
        return {
          status: 'invalid',
          error: 'Use exactly one mode: `old` with `new`, or `edits: [{old, new}]`, or `startLine`/`endLine` with `newText`.',
        };
      }

      const path = context?.target ?? resolveFileTarget(input, workspaceRoot) ?? source;
      let details;
      try {
        details = await stat(path);
      } catch {
        return { status: 'invalid', path: path.slice(0, 512), error: 'file_edit needs an existing file; use file_write to create it.' };
      }
      if (!details.isFile()) return { status: 'invalid', path: path.slice(0, 512), error: 'path must refer to a regular file.' };
      if (details.size > MAX_WRITE_BYTES) {
        return { status: 'too_large', path: path.slice(0, 512), sizeBytes: details.size, maxBytes: MAX_WRITE_BYTES };
      }

      const bytes = await readFile(path, signal ? { signal } : undefined);
      let content: string;
      try {
        content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      } catch {
        return { status: 'unsupported', path: path.slice(0, 512), error: 'Only UTF-8 text files can be edited.' };
      }

      /** Line number (1-based) the first replaced character sits on. */
      const lineAt = (position: number) => content.slice(0, position).split('\n').length;
      let next: string;
      let mode: 'replace' | 'edits' | 'range';
      let detailsOut: Record<string, unknown>;

      if (multi) {
        const parsed = parseReplacements(input.edits);
        if (!parsed.ok) return { status: 'invalid', path: path.slice(0, 512), error: parsed.error };
        const resolved: { start: number; end: number; text: string; index: number; occurrence: number; occurrences: number }[] = [];
        for (let index = 0; index < parsed.edits.length; index++) {
          const edit = parsed.edits[index]!;
          const positions = matchPositions(content, edit.old);
          if (positions.length === 0) {
            return {
              status: 'no_match',
              path: path.slice(0, 512),
              edit: index + 1,
              occurrences: 0,
              error: `edits[${index}] was not found in the current content. file_read the file and retry with text copied from it. Nothing was written.`,
            };
          }
          if (edit.occurrence === undefined && positions.length > 1) {
            return {
              status: 'ambiguous',
              path: path.slice(0, 512),
              edit: index + 1,
              occurrences: positions.length,
              error: `edits[${index}] matches ${positions.length} places; add its occurrence so the edit is unambiguous. Nothing was written.`,
            };
          }
          const occurrence = edit.occurrence ?? 1;
          if (occurrence > positions.length) {
            return {
              status: 'occurrence_out_of_range',
              path: path.slice(0, 512),
              edit: index + 1,
              occurrences: positions.length,
              error: `edits[${index}] names occurrence ${occurrence}, but the file has ${positions.length} match(es). Nothing was written.`,
            };
          }
          const start = positions[occurrence - 1]!;
          resolved.push({ start, end: start + edit.old.length, text: edit.new, index, occurrence, occurrences: positions.length });
        }
        // Overlapping edits are ambiguous: the second one would apply to text the
        // first already replaced.
        const byPosition = [...resolved].sort((left, right) => left.start - right.start);
        for (let index = 1; index < byPosition.length; index++) {
          if (byPosition[index]!.start < byPosition[index - 1]!.end) {
            return {
              status: 'invalid',
              path: path.slice(0, 512),
              error: `edits[${byPosition[index - 1]!.index}] and edits[${byPosition[index]!.index}] overlap. Nothing was written.`,
            };
          }
        }
        let edited = content;
        for (const edit of [...byPosition].reverse()) {
          edited = edited.slice(0, edit.start) + edit.text + edited.slice(edit.end);
        }
        next = edited;
        mode = 'edits';
        detailsOut = {
          applied: resolved.length,
          edits: byPosition.map((edit) => ({
            edit: edit.index + 1,
            line: lineAt(edit.start),
            occurrence: edit.occurrence,
            occurrences: edit.occurrences,
          })),
        };
      } else if (ranged) {
        const startLine = input.startLine;
        const newText = input.newText;
        if (!Number.isSafeInteger(startLine) || Number(startLine) < 1) {
          return { status: 'invalid', path: path.slice(0, 512), error: 'startLine must be a positive 1-based line number.' };
        }
        if (typeof newText !== 'string') {
          return { status: 'invalid', path: path.slice(0, 512), error: 'newText must be a string; use "" to delete the lines.' };
        }
        const endLine = input.endLine === undefined ? Number(startLine) : input.endLine;
        if (!Number.isSafeInteger(endLine) || Number(endLine) < Number(startLine)) {
          return { status: 'invalid', path: path.slice(0, 512), error: 'endLine must be a line number at or after startLine.' };
        }
        const anchor = typeof input.anchor === 'string' ? input.anchor : null;
        if (!anchor) {
          return {
            status: 'invalid',
            path: path.slice(0, 512),
            error:
              'Range edits need `anchor`: the exact current text of the startLine. Line numbers alone can point at the wrong lines after an earlier change.',
          };
        }
        // Replace whole lines in the file's own line ending, so a CRLF file stays
        // CRLF and the replacement text never mixes conventions.
        const eol = content.includes('\r\n') ? '\r\n' : '\n';
        const lines = content.split(eol);
        const first = Number(startLine);
        const last = Number(endLine);
        if (first > lines.length) {
          return {
            status: 'line_out_of_range',
            path: path.slice(0, 512),
            lineCount: lines.length,
            error: `startLine ${first} is past the last line (${lines.length}). Nothing was written.`,
          };
        }
        if (last > lines.length) {
          return {
            status: 'line_out_of_range',
            path: path.slice(0, 512),
            lineCount: lines.length,
            error: `endLine ${last} is past the last line (${lines.length}). Nothing was written.`,
          };
        }
        const actualFirstLine = lines[first - 1] ?? '';
        if (actualFirstLine !== anchor) {
          return {
            status: 'stale_range',
            path: path.slice(0, 512),
            line: first,
            actual: actualFirstLine.slice(0, 300),
            error: `Line ${first} is not the anchor text; the file changed since it was read. Nothing was written.`,
          };
        }
        const boundedLast = last;
        const replacement = newText === '' ? [] : newText.split(/\r?\n/);
        next = [...lines.slice(0, first - 1), ...replacement, ...lines.slice(boundedLast)].join(eol);
        mode = 'range';
        detailsOut = { startLine: first, endLine: boundedLast, linesReplaced: boundedLast - first + 1, line: first };
      } else {
        const old = typeof input.old === 'string' ? input.old : null;
        const replacement = typeof input.new === 'string' ? input.new : null;
        const requestedOccurrence = input.occurrence;
        if (old === null) return { status: 'invalid', error: 'old must be a string.' };
        if (!old) return { status: 'invalid', error: 'old must not be empty; file_write creates or replaces a whole file.' };
        if (replacement === null) return { status: 'invalid', error: 'new must be a string.' };
        if (
          requestedOccurrence !== undefined &&
          (!Number.isSafeInteger(requestedOccurrence) || Number(requestedOccurrence) < 1 || Number(requestedOccurrence) > 100_000)
        ) {
          return { status: 'invalid', error: 'occurrence must be a positive 1-based match number.' };
        }
        const occurrence = typeof requestedOccurrence === 'number' ? requestedOccurrence : 1;
        const positions = matchPositions(content, old);
        if (positions.length === 0) {
          return {
            status: 'no_match',
            path: path.slice(0, 512),
            occurrences: 0,
            error: 'The exact `old` text was not found. file_read the current content and retry with text copied from it.',
          };
        }
        if (occurrence > positions.length) {
          return {
            status: 'occurrence_out_of_range',
            path: path.slice(0, 512),
            occurrences: positions.length,
            error: `The file contains ${positions.length} matching occurrence(s), so occurrence ${occurrence} does not exist.`,
          };
        }
        const position = positions[occurrence - 1]!;
        next = content.slice(0, position) + replacement + content.slice(position + old.length);
        mode = 'replace';
        detailsOut = { line: lineAt(position), occurrence, occurrences: positions.length };
      }

      const stamped =
        isMemoryDocumentPath(path, workspaceRoot) && !isMemoryIndexPath(path, workspaceRoot) ? stampMemoryDocumentDate(next) : next;
      const validation = validateTextWrite(stamped, path, workspaceRoot);
      if (!validation.ok) return validation.failure;
      const integrity = inspectTextIntegrity({ before: content, after: stamped, path });
      if (integrity.errors.length > 0) {
        return {
          status: 'integrity',
          path: path.slice(0, 512),
          errors: integrity.errors,
          error: 'The edit would damage the file; nothing was written.',
        };
      }
      const leaseDenied = context?.guardWrite?.(path);
      if (leaseDenied) return { status: 'denied', path: path.slice(0, 512), error: leaseDenied };
      await writeTextAtomically(path, stamped);
      const change = diffStat(content, stamped);
      return {
        status: 'completed',
        path: path.slice(0, 512),
        mode,
        ...detailsOut,
        sizeBytes: validation.sizeBytes,
        sha256: validation.sha256,
        oldLineCount: content.split(/\r?\n/).length,
        lineCount: stamped.split(/\r?\n/).length,
        ...(integrity.warnings.length > 0 ? { integrityWarnings: integrity.warnings } : {}),
        ...(change === null ? {} : { addedLines: change.addedLines, removedLines: change.removedLines }),
        ...(await memoryIndexOutcome(memoryIndex, path, workspaceRoot)),
      };
    },
  };
}
