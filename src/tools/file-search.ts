import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { classifyFilePath, resolveFilePath, resolveFileTarget } from '../file-write-core.js';
import { isMemoryDocumentPath, isMemoryIndexPath } from '../memory-paths.js';
import { isTrustedSkillResourcePath } from '../skills.js';
import type { ToolDefinition, ToolEffect } from './registry.js';
import { classifyTrustedPath, trustedRootsFor } from '../workspace-scope.js';

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_FILES_SCANNED = 20_000;
const MAX_MATCH_LINE_CHARS = 300;
const GREP_DEFAULT_RESULTS = 50;
const GREP_MAX_RESULTS = 200;
const GLOB_DEFAULT_RESULTS = 100;
const GLOB_MAX_RESULTS = 500;

/** Dependency trees and repository metadata are near-universal noise; an explicit root inside them still works. */
const SKIPPED_DIRECTORY_NAMES = new Set(['.git', 'node_modules']);

const searchEffect: ToolEffect = {
  change: 'none',
  data: 'sensitive',
  network: 'none',
  reversible: 'full',
  outbound: 'model',
};

/** Lists files whose path matches a glob pattern, without reading their content. */
export function createGlobTool(workspaceRoot = process.cwd()): ToolDefinition {
  return {
    providerId: 'host',
    name: 'glob',
    description:
      'Find files by glob pattern under a directory and return their paths. `pattern` supports `**` (any depth), `*` (within one path segment), and `?`; a pattern without `/` matches the file name at any depth, for example `*.ts` or `src/**/test_*.py`. Recursion skips `.git` and `node_modules` and never follows symlinks. Results are capped by `max_results` and a `truncated` flag reports when the cap was hit. Use it to locate files; use grep to search their content and file_read to read them.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Glob pattern such as `src/**/*.ts`, `**/Dockerfile`, or `*.json`.' },
        path: {
          type: 'string',
          description: 'Optional absolute or workspace-relative directory (or file) to search under; defaults to the workspace root.',
        },
        max_results: {
          type: 'integer',
          minimum: 1,
          maximum: GLOB_MAX_RESULTS,
          description: `Optional result cap; defaults to ${GLOB_DEFAULT_RESULTS}.`,
        },
      },
      required: ['pattern'],
      additionalProperties: false,
    },
    effect: searchEffect,
    resolveTarget: (input) => resolveFileTarget(input, workspaceRoot),
    workspaceScope: (input, target) => classifySearchScope(input, target, workspaceRoot),
    autoApprove: (input, target) => isSearchPreAuthorized(input, target, workspaceRoot),
    assess: (input, target) => ({ ...searchEffect, data: classifyFilePath(target ?? searchSource(input), workspaceRoot) }),
    execute: async (input, signal, context) => {
      const pattern = typeof input.pattern === 'string' ? input.pattern.trim() : '';
      if (!pattern) return { status: 'invalid', error: 'pattern must be a non-empty glob string.' };
      const requestedLimit = input.max_results;
      if (
        requestedLimit !== undefined &&
        (!Number.isSafeInteger(requestedLimit) || Number(requestedLimit) < 1 || Number(requestedLimit) > GLOB_MAX_RESULTS)
      ) {
        return { status: 'invalid', error: `max_results must be between 1 and ${GLOB_MAX_RESULTS}.` };
      }
      const limit = typeof requestedLimit === 'number' ? requestedLimit : GLOB_DEFAULT_RESULTS;
      const root = context?.target ?? resolveFileTarget(input, workspaceRoot) ?? resolveFilePath(searchSource(input), workspaceRoot);
      const details = await statIfPossible(root);
      if (!details) return { status: 'invalid', path: root.slice(0, 512), error: 'path does not exist.' };
      if (!details.isDirectory()) return { status: 'invalid', path: root.slice(0, 512), error: 'glob needs a directory to search.' };

      const matches = globMatcher(pattern);
      const files: string[] = [];
      let scanned = 0;
      let truncated = false;
      for await (const entry of walkFiles(root, signal)) {
        scanned++;
        if (scanned > MAX_FILES_SCANNED) {
          truncated = true;
          break;
        }
        if (!matches(entry.relative)) continue;
        files.push(entry.path);
        if (files.length >= limit) {
          truncated = true;
          break;
        }
      }
      files.sort((left, right) => left.localeCompare(right));
      return {
        status: 'completed',
        path: root.slice(0, 512),
        pattern,
        files: files.map((file) => file.slice(0, 512)),
        count: files.length,
        scanned,
        truncated,
      };
    },
  };
}

/** Searches text file contents for a literal string or regular expression. */
export function createGrepTool(workspaceRoot = process.cwd()): ToolDefinition {
  return {
    providerId: 'host',
    name: 'grep',
    description:
      'Search local text files for a string or regular expression and return matching lines as file, 1-based line number, and line text. Recursion skips `.git` and `node_modules`, ignores binary files, and never follows symlinks. `glob` filters candidate files (`*.ts`, `src/**/*.js`, a name without `/` matches at any depth). Matching is case-sensitive in both modes. Results are capped by `max_results` and a `truncated` flag reports when the cap was hit. Treat matches as pointers and read the cited range with file_read before relying on surrounding context or editing.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Text to find; a JavaScript regular expression when `regex` is true.' },
        path: {
          type: 'string',
          description: 'Optional absolute or workspace-relative file or directory to search; defaults to the workspace root.',
        },
        glob: { type: 'string', description: 'Optional file filter such as `*.ts` or `src/**/*.js`.' },
        regex: { type: 'boolean', description: 'Treat `pattern` as a regular expression instead of a literal string.' },
        max_results: {
          type: 'integer',
          minimum: 1,
          maximum: GREP_MAX_RESULTS,
          description: `Optional match cap; defaults to ${GREP_DEFAULT_RESULTS}.`,
        },
      },
      required: ['pattern'],
      additionalProperties: false,
    },
    effect: searchEffect,
    resolveTarget: (input) => resolveFileTarget(input, workspaceRoot),
    workspaceScope: (input, target) => classifySearchScope(input, target, workspaceRoot),
    autoApprove: (input, target) => isSearchPreAuthorized(input, target, workspaceRoot),
    assess: (input, target) => ({ ...searchEffect, data: classifyFilePath(target ?? searchSource(input), workspaceRoot) }),
    execute: async (input, signal, context) => {
      const pattern = typeof input.pattern === 'string' ? input.pattern : '';
      if (!pattern) return { status: 'invalid', error: 'pattern must be a non-empty string.' };
      const requestedLimit = input.max_results;
      if (
        requestedLimit !== undefined &&
        (!Number.isSafeInteger(requestedLimit) || Number(requestedLimit) < 1 || Number(requestedLimit) > GREP_MAX_RESULTS)
      ) {
        return { status: 'invalid', error: `max_results must be between 1 and ${GREP_MAX_RESULTS}.` };
      }
      const limit = typeof requestedLimit === 'number' ? requestedLimit : GREP_DEFAULT_RESULTS;
      let testLine: (line: string) => boolean;
      if (input.regex === true) {
        try {
          const expression = new RegExp(pattern);
          testLine = (line) => expression.test(line);
        } catch (error) {
          return { status: 'invalid', error: `Invalid regular expression: ${error instanceof Error ? error.message : String(error)}` };
        }
      } else {
        testLine = (line) => line.includes(pattern);
      }
      const glob = typeof input.glob === 'string' ? input.glob.trim() : '';
      const matchesGlob = glob ? globMatcher(glob) : () => true;
      const root = context?.target ?? resolveFileTarget(input, workspaceRoot) ?? resolveFilePath(searchSource(input), workspaceRoot);
      const details = await statIfPossible(root);
      if (!details) return { status: 'invalid', path: root.slice(0, 512), error: 'path does not exist.' };
      if (!details.isDirectory() && !details.isFile()) {
        return { status: 'invalid', path: root.slice(0, 512), error: 'path must refer to a regular file or directory.' };
      }

      const candidates: Array<{ path: string; relative: string }> = [];
      let scanCapped = false;
      if (details.isFile()) {
        candidates.push({ path: root, relative: basename(root) });
      } else {
        let scanned = 0;
        for await (const entry of walkFiles(root, signal)) {
          scanned++;
          if (scanned > MAX_FILES_SCANNED) {
            scanCapped = true;
            break;
          }
          if (matchesGlob(entry.relative)) candidates.push(entry);
        }
        candidates.sort((left, right) => left.relative.localeCompare(right.relative));
      }

      const matches: Array<{ path: string; line: number; text: string }> = [];
      let filesSearched = 0;
      let truncated = scanCapped;
      for (const candidate of candidates) {
        if (signal?.aborted) throw new Error('The run was stopped by the user.');
        if (matches.length >= limit) {
          truncated = true;
          break;
        }
        let bytes: Buffer;
        try {
          bytes = await readFile(candidate.path, signal ? { signal } : undefined);
        } catch {
          continue;
        }
        if (bytes.length > MAX_FILE_BYTES || bytes.includes(0)) continue;
        let content: string;
        try {
          content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        } catch {
          continue;
        }
        filesSearched++;
        const lines = content.split(/\r?\n/);
        for (let index = 0; index < lines.length; index++) {
          const line = lines[index]!;
          if (!testLine(line)) continue;
          const trimmed = line.length > MAX_MATCH_LINE_CHARS ? `${line.slice(0, MAX_MATCH_LINE_CHARS)}…` : line;
          matches.push({ path: candidate.path.slice(0, 512), line: index + 1, text: trimmed });
          if (matches.length >= limit) {
            truncated = true;
            break;
          }
        }
      }
      return {
        status: 'completed',
        path: root.slice(0, 512),
        pattern,
        regex: input.regex === true,
        ...(glob ? { glob } : {}),
        matches,
        matchCount: matches.length,
        filesSearched,
        truncated,
      };
    },
  };
}

function searchSource(input: Record<string, unknown>): string {
  return typeof input.path === 'string' && input.path.trim() ? input.path.trim() : '.';
}

function classifySearchScope(input: Record<string, unknown>, target: string | undefined, workspaceRoot: string) {
  try {
    return classifyTrustedPath(target ?? resolveFilePath(searchSource(input), workspaceRoot), trustedRootsFor(workspaceRoot));
  } catch {
    return 'unknown' as const;
  }
}

function isSearchPreAuthorized(input: Record<string, unknown>, target: string | undefined, workspaceRoot: string): boolean {
  const path = target ?? (typeof input.path === 'string' ? input.path : '');
  return (
    isMemoryIndexPath(path, workspaceRoot) || isMemoryDocumentPath(path, workspaceRoot) || isTrustedSkillResourcePath(path, workspaceRoot)
  );
}

async function statIfPossible(path: string) {
  try {
    return await stat(path);
  } catch {
    return null;
  }
}

type WalkEntry = { path: string; relative: string };

/** Depth-first walk; skips noise directories and symlinks, and never escapes the root. */
async function* walkFiles(root: string, signal?: AbortSignal): AsyncGenerator<WalkEntry> {
  const stack: WalkEntry[] = [{ path: root, relative: '' }];
  while (stack.length > 0) {
    signal?.throwIfAborted();
    const current = stack.pop()!;
    let entries;
    try {
      entries = await readdir(current.path, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const entryPath = join(current.path, entry.name);
      const entryRelative = current.relative ? `${current.relative}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORY_NAMES.has(entry.name)) {
          stack.push({ path: entryPath, relative: entryRelative });
        }
        continue;
      }
      if (entry.isFile()) yield { path: entryPath, relative: entryRelative };
    }
  }
}

/**
 * Compiles a glob into a path matcher.
 *
 * `**` crosses directory boundaries, `*` and `?` stay inside one segment. A
 * pattern without `/` also matches the file's base name, so `*.ts` finds files
 * at any depth.
 */
function globMatcher(pattern: string): (relativePath: string) => boolean {
  const normalized = pattern.replace(/\\/g, '/');
  const expression = new RegExp(`^${globToRegExpSource(normalized)}$`);
  if (normalized.includes('/')) return (relativePath) => expression.test(relativePath);
  return (relativePath) => expression.test(relativePath) || expression.test(basename(relativePath));
}

function globToRegExpSource(glob: string): string {
  let source = '';
  for (let index = 0; index < glob.length; index++) {
    const character = glob[index]!;
    if (character === '*') {
      if (glob[index + 1] === '*') {
        index++;
        if (glob[index + 1] === '/') {
          index++;
          source += '(?:[^/]+/)*';
        } else {
          source += '.*';
        }
      } else {
        source += '[^/]*';
      }
      continue;
    }
    if (character === '?') {
      source += '[^/]';
      continue;
    }
    source += character.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return source;
}
