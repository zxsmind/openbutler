import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import {
  classifyFilePath,
  diffStat,
  memoryIndexOutcome,
  MAX_WRITE_BYTES,
  resolveFilePath,
  resolveFileTarget,
  stampMemoryDocumentDate,
  validateTextWrite,
  writeTextAtomically,
} from '../file-write-core.js';
import { classifyHostOwnedPath } from '../host-owned-paths.js';
import { isMemoryDocumentPath, isMemoryIndexPath } from '../memory-paths.js';
import { inspectTextIntegrity } from '../text-integrity.js';
import type { MemoryIndex } from '../memory-index.js';
import { type ToolDefinition, type ToolEffect } from './registry.js';
import { classifyTrustedPath, trustedRootsFor } from '../workspace-scope.js';

const writeEffect: ToolEffect = {
  change: 'modify',
  data: 'sensitive',
  network: 'none',
  reversible: 'compensating',
  outbound: 'none',
};

/** Writes UTF-8 text. The shared registry applies the normal approval policy. */
export function createWriteTool(workspaceRoot = process.cwd(), memoryIndex?: MemoryIndex): ToolDefinition {
  return {
    providerId: 'host',
    name: 'file_write',
    description:
      'Create or replace a local UTF-8 text file with the supplied content; this replaces the entire file. A successful write returns sha256 for the exact UTF-8 bytes written, the line counts, and added/removed line stats; file_read.sha256 reports the current on-disk file hash. Workspace writes follow the active permission mode. OpenButler-owned paths (scratch, memory, settings) are pre-authorized. For memory, use the paths and the flat summary-plus-bullets schema in the system instructions; keep MEMORY.md as one concise index and edit existing scoped notes instead of making duplicate indexes.',
    maxInputChars: MAX_WRITE_BYTES + 100_000,
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute or workspace-relative destination path.' },
        content: { type: 'string', description: 'Complete UTF-8 text to write; replaces the current file.' },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },
    effect: writeEffect,
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
      const path = target ?? (typeof input.path === 'string' ? resolveFilePath(input.path, workspaceRoot) : workspaceRoot);
      return {
        ...writeEffect,
        change: existsSync(path) ? 'modify' : 'create',
        data: classifyFilePath(path, workspaceRoot),
      };
    },
    execute: async (input, _signal, context) => {
      const source = typeof input.path === 'string' ? input.path.trim() : '';
      const content = typeof input.content === 'string' ? input.content : null;
      if (!source) return { status: 'invalid', error: 'path must be a non-empty string.' };
      if (content === null) return { status: 'invalid', error: 'content must be a string.' };
      const path = context?.target ?? resolveFilePath(source, workspaceRoot);
      const text =
        isMemoryDocumentPath(path, workspaceRoot) && !isMemoryIndexPath(path, workspaceRoot) ? stampMemoryDocumentDate(content) : content;
      const validation = validateTextWrite(text, path, workspaceRoot);
      if (!validation.ok) return validation.failure;
      const leaseDenied = context?.guardWrite?.(path);
      if (leaseDenied) return { status: 'denied', path: path.slice(0, 512), error: leaseDenied };
      const existed = existsSync(path);
      let previous: string | null = null;
      if (existed) {
        try {
          const oldBytes = await readFile(path);
          if (oldBytes.length <= MAX_WRITE_BYTES) previous = new TextDecoder('utf-8', { fatal: true }).decode(oldBytes);
        } catch {
          previous = null;
        }
      }
      const integrity = inspectTextIntegrity({ before: previous, after: text, path });
      if (integrity.errors.length > 0) {
        return {
          status: 'integrity',
          path: path.slice(0, 512),
          errors: integrity.errors,
          error: 'The write would damage the file; nothing was written.',
        };
      }
      await writeTextAtomically(path, text);
      const lineCount = text.split(/\r?\n/).length;
      const stat = !existed ? { addedLines: lineCount, removedLines: 0 } : previous === null ? null : diffStat(previous, text);
      return {
        status: 'completed',
        path: path.slice(0, 512),
        sizeBytes: validation.sizeBytes,
        sha256: validation.sha256,
        created: !existed,
        lineCount,
        ...(previous === null ? {} : { oldLineCount: previous.split(/\r?\n/).length }),
        ...(stat === null ? {} : { addedLines: stat.addedLines, removedLines: stat.removedLines }),
        ...(integrity.warnings.length > 0 ? { integrityWarnings: integrity.warnings } : {}),
        ...(await memoryIndexOutcome(memoryIndex, path, workspaceRoot)),
      };
    },
  };
}
