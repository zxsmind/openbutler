/**
 * The memory tree as a person reads it: which notes exist, what each one says,
 * and when it was last written.
 *
 * The daemon writes this tree; everything here only reads it. The body travels
 * without its frontmatter so a client renders prose instead of printing YAML.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import { parseMemoryDocument, type MemoryScope, type MemoryType } from './memory-document.js';
import { getMemoryPaths } from './memory-paths.js';

/**
 * One note is shown inside a settings page, not archived. A body past this
 * length is cut and marked, so a pathological file cannot stall the page.
 */
export const MEMORY_BODY_LIMIT_CHARS = 48_000;

/** A tree larger than this is already a problem; the page shows the first part. */
const MAX_FILES = 400;

export type MemoryFileGroup = 'preferences' | 'profile' | 'topics' | 'areas' | 'workspace';

export interface MemoryFileView {
  /** Path relative to the memory root, always with forward slashes. */
  name: string;
  group: MemoryFileGroup;
  scope: MemoryScope;
  title: string;
  description: string;
  updated: string;
  type: MemoryType;
  bytes: number;
  /** Markdown after the frontmatter, for a renderer rather than a text block. */
  body: string;
  /** True when the body was cut at MEMORY_BODY_LIMIT_CHARS. */
  truncated: boolean;
}

export interface MemoryIndexView {
  name: string;
  present: boolean;
  bytes: number;
  lines: number;
}

export interface MemorySnapshot {
  root: string;
  index: MemoryIndexView;
  files: MemoryFileView[];
  /** Notes found beyond MAX_FILES; they are not returned. */
  omitted: number;
}

export function readMemorySnapshot(workspaceRoot: string): MemorySnapshot {
  const paths = getMemoryPaths(workspaceRoot);
  const files: MemoryFileView[] = [];
  let omitted = 0;

  const add = (file: string, group: MemoryFileGroup, scope: MemoryScope) => {
    const view = readMemoryFile(file, paths.root, group, scope);
    if (!view) return;
    if (files.length >= MAX_FILES) {
      omitted += 1;
      return;
    }
    files.push(view);
  };

  add(paths.preferencesFile, 'preferences', 'user');
  add(paths.userFile, 'profile', 'user');
  for (const file of markdownFiles(paths.topicsDirectory)) add(file, 'topics', 'user');
  for (const file of markdownFiles(paths.areasDirectory)) add(file, 'areas', 'user');
  add(paths.workspaceFile, 'workspace', `workspace:${paths.workspaceKey}`);

  return { root: paths.root, index: readIndex(paths.indexFile), files, omitted };
}

function markdownFiles(directory: string): string[] {
  try {
    return readdirSync(directory)
      .filter((entry) => entry.toLowerCase().endsWith('.md'))
      .sort((left, right) => left.localeCompare(right))
      .map((entry) => resolve(directory, entry));
  } catch {
    // A scope with no notes yet is normal, not an error.
    return [];
  }
}

function readMemoryFile(file: string, root: string, group: MemoryFileGroup, scope: MemoryScope): MemoryFileView | null {
  let content: string;
  try {
    if (!statSync(file).isFile()) return null;
    content = readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const document = parseMemoryDocument(content, file, scope);
  const body = stripFrontmatter(content);
  const truncated = body.length > MEMORY_BODY_LIMIT_CHARS;
  return {
    name: relative(root, file).split(sep).join('/'),
    group,
    scope,
    title: document.title,
    description: document.description,
    updated: document.updated,
    type: document.type,
    bytes: Buffer.byteLength(content, 'utf8'),
    body: truncated ? body.slice(0, MEMORY_BODY_LIMIT_CHARS) : body,
    truncated,
  };
}

function readIndex(file: string): MemoryIndexView {
  try {
    const content = readFileSync(file, 'utf8');
    return { name: 'MEMORY.md', present: true, bytes: Buffer.byteLength(content, 'utf8'), lines: content.split(/\r?\n/).length };
  } catch {
    return { name: 'MEMORY.md', present: false, bytes: 0, lines: 0 };
  }
}

/** The frontmatter is metadata, not content: the reader shows what follows it. */
export function stripFrontmatter(content: string): string {
  const match = /^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/.exec(content);
  return (match ? content.slice(match[0].length) : content).trim();
}
