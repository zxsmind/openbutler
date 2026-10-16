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
import type { ToolDefinition, ToolEffect } from './registry.js';
import { classifyTrustedPath, trustedRootsFor } from '../workspace-scope.js';

const editEffect: ToolEffect = {
  change: 'modify',
  data: 'sensitive',
  network: 'none',
  reversible: 'compensating',
  outbound: 'none',
};

/** Replaces one exact occurrence inside an existing UTF-8 text file. */
export function createEditTool(workspaceRoot = process.cwd(), memoryIndex?: MemoryIndex): ToolDefinition {
  return {
    providerId: 'host',
    name: 'file_edit',
    description:
      'Replace one exact occurrence of a string inside an existing local UTF-8 text file without rewriting the whole file. `old` must match the current file content exactly, including whitespace and line breaks. `occurrence` selects which match to replace (1-based, default 1); the result reports how many matches exist, the edited line, the line counts, added/removed line stats, and the sha256 of the written text, so an ambiguous edit is visible before the next call. Prefer file_edit over file_write for targeted changes; use file_write only to create a file or replace it completely. Workspace writes follow the active permission mode. Ranite-owned paths (scratch, memory, settings) are pre-authorized and keep the same structure validation as file_write.',
    maxInputChars: MAX_WRITE_BYTES * 2 + 100_000,
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute or workspace-relative path of the existing file to edit.' },
        old: { type: 'string', description: 'Exact text to find in the current file content, including whitespace.' },
        new: { type: 'string', description: 'Replacement text; an empty string deletes the matched text.' },
        occurrence: {
          type: 'integer',
          minimum: 1,
          description: 'Which 1-based occurrence of `old` to replace; defaults to the first.',
        },
      },
      required: ['path', 'old', 'new'],
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
      return classifyHostOwnedPath(source, workspaceRoot) !== null;
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
      const old = typeof input.old === 'string' ? input.old : null;
      const replacement = typeof input.new === 'string' ? input.new : null;
      const requestedOccurrence = input.occurrence;
      if (!source) return { status: 'invalid', error: 'path must be a non-empty string.' };
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

      const positions: number[] = [];
      let found = content.indexOf(old);
      while (found !== -1) {
        positions.push(found);
        found = content.indexOf(old, found + old.length);
      }
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
      const edited = content.slice(0, position) + replacement + content.slice(position + old.length);
      const next =
        isMemoryDocumentPath(path, workspaceRoot) && !isMemoryIndexPath(path, workspaceRoot) ? stampMemoryDocumentDate(edited) : edited;
      const validation = validateTextWrite(next, path, workspaceRoot);
      if (!validation.ok) return validation.failure;
      const leaseDenied = context?.guardWrite?.(path);
      if (leaseDenied) return { status: 'denied', path: path.slice(0, 512), error: leaseDenied };
      await writeTextAtomically(path, next);
      const line = content.slice(0, position).split('\n').length;
      const change = diffStat(content, next);
      return {
        status: 'completed',
        path: path.slice(0, 512),
        line,
        occurrence,
        occurrences: positions.length,
        sizeBytes: validation.sizeBytes,
        sha256: validation.sha256,
        oldLineCount: content.split(/\r?\n/).length,
        lineCount: next.split(/\r?\n/).length,
        ...(change === null ? {} : { addedLines: change.addedLines, removedLines: change.removedLines }),
        ...(await memoryIndexOutcome(memoryIndex, path, workspaceRoot)),
      };
    },
  };
}
