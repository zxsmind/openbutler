import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { getMemoryPaths } from './memory-paths.js';
import { classifyWorkspacePath } from './workspace-scope.js';

export interface MemoryLayoutMigration {
  moved: Array<{ from: string; to: string }>;
  conflicts: string[];
}

/** Idempotent, synchronous initialization: profiles and topic files retain their contents and scopes. */
export function migrateMemoryLayout(workspaceRoot = process.cwd()): MemoryLayoutMigration {
  const paths = getMemoryPaths(workspaceRoot);
  mkdirSync(paths.root, { recursive: true });
  const report: MemoryLayoutMigration = { moved: [], conflicts: [] };
  const safe = (path: string) => {
    if (classifyWorkspacePath(path, paths.root) !== 'workspace')
      throw new Error(`Memory migration target escapes the memory root: ${path}`);
  };
  const regular = (path: string) => existsSync(path) && !lstatSync(path).isSymbolicLink();
  const entryExists = (path: string) => {
    try {
      lstatSync(path);
      return true;
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  };
  const linkTargets = new Map<string, string>();
  const moveFile = (from: string, requested: string) => {
    if (!regular(from) || !lstatSync(from).isFile()) return;
    safe(from);
    safe(requested);
    let to = requested;
    let linkTarget = requested;
    if (entryExists(to)) {
      const bytes = readFileSync(from);
      const suffix = createHash('sha256').update(bytes).digest('hex').slice(0, 12);
      const name =
        relative(paths.root, from)
          .split(sep)
          .join('--')
          .toLowerCase()
          .replace(/[^a-z0-9-]+/g, '-')
          .replace(/^-|-$/g, '') || 'note';
      let collision = 1;
      do {
        to = resolve(paths.root, '.migration', 'layout-v2', 'conflicts', `${name}-${suffix}-${collision}.md`);
        safe(to);
        collision++;
      } while (entryExists(to));
      // Conflicting imports are retained outside searchable scopes. References
      // continue to resolve to the canonical note already at the requested path.
      linkTarget = requested;
      report.conflicts.push(to);
    }
    mkdirSync(dirname(to), { recursive: true });
    renameSync(from, to);
    linkTargets.set(pathKey(from), linkTarget);
    report.moved.push({ from, to });
  };
  const moveTree = (from: string, to: string): void => {
    if (!regular(from) || !lstatSync(from).isDirectory()) return;
    safe(from);
    safe(to);
    for (const entry of readdirSync(from, { withFileTypes: true })) {
      const source = resolve(from, entry.name);
      const destination = resolve(to, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) moveTree(source, destination);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) moveFile(source, destination);
    }
    if (readdirSync(from).length === 0) rmdirSync(from);
  };
  const migrateUserTopics = () => {
    const directory = resolve(paths.root, 'user');
    if (!regular(directory) || !lstatSync(directory).isDirectory()) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (['profile.md', 'notes'].includes(entry.name.toLowerCase())) continue;
      const from = resolve(directory, entry.name);
      const to = resolve(paths.userTopicsDirectory, entry.name);
      if (entry.isDirectory() && !entry.isSymbolicLink()) moveTree(from, to);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) moveFile(from, to);
    }
  };
  moveFile(resolve(paths.root, 'user.md'), paths.userFile);
  migrateUserTopics();
  for (const entry of readdirSync(paths.root, { withFileTypes: true })) {
    const workspaceKey = entry.name.toLowerCase();
    if (!entry.isDirectory() || entry.isSymbolicLink() || !/^[a-f0-9]{24}$/.test(workspaceKey)) continue;
    const old = resolve(paths.root, entry.name);
    const next = resolve(paths.root, 'workspaces', workspaceKey);
    const notes = resolve(next, 'notes');
    moveFile(resolve(old, 'workspace.md'), resolve(next, 'profile.md'));
    moveTree(resolve(old, 'topics'), notes);
    moveTree(old, notes);
  }
  if (!report.moved.length) return report;

  const moves = linkTargets;
  const archivedPaths = new Set(report.conflicts.map(pathKey));
  const updateLinks = (content: string, from: string, to: string) =>
    rewriteMarkdownOutsideCode(content, (line) =>
      line.replace(/(\[[^\]\n]*\]\()(<[^>]+>|[^)\s]+)(\))/g, (whole, start: string, link: string, end: string) => {
        const target = link.replace(/^<|>$/g, '');
        if (/^[a-z]+:\/\//i.test(target) || target.startsWith('#')) return whole;
        const [path, anchor] = target.split('#', 2);
        const oldTarget = resolve(dirname(from), path!);
        const moved = moves.get(pathKey(oldTarget));
        const retained =
          moved ?? (classifyWorkspacePath(oldTarget, paths.root) === 'workspace' && existsSync(oldTarget) ? oldTarget : null);
        if (!retained) return whole;
        const next = relative(dirname(to), retained).split(sep).join('/') + (anchor ? `#${anchor}` : '');
        return `${start}${next.includes(' ') ? `<${next}>` : next}${end}`;
      }),
    );
  for (const move of report.moved) {
    if (archivedPaths.has(pathKey(move.to))) continue;
    const content = readFileSync(move.to, 'utf8');
    const updated = updateLinks(content, move.from, move.to);
    if (updated !== content) atomicWrite(move.to, updated);
  }
  if (regular(paths.indexFile)) {
    const original = readFileSync(paths.indexFile, 'utf8');
    const updated = updateLinks(original, paths.indexFile, paths.indexFile);
    if (updated !== original) {
      const stamp = createHash('sha256').update(original).digest('hex').slice(0, 12);
      const backup = resolve(paths.root, '.migration', 'layout-v2', `index-before-${stamp}.txt`);
      safe(backup);
      mkdirSync(dirname(backup), { recursive: true });
      if (!existsSync(backup)) writeFileSync(backup, original, 'utf8');
      atomicWrite(paths.indexFile, updated);
    }
  }
  return report;
}

function atomicWrite(path: string, content: string): void {
  const temporary = `${path}.${randomUUID()}.migration.tmp`;
  try {
    writeFileSync(temporary, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    renameSync(temporary, path);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
      /* no temporary file remains */
    }
    throw error;
  }
}

/** Rewrite Markdown links while retaining code examples byte-for-byte. */
function rewriteMarkdownOutsideCode(content: string, rewrite: (segment: string) => string): string {
  const parts = content.split(/(\r\n|\n|\r)/);
  let fence: { marker: string; length: number } | null = null;
  for (let index = 0; index < parts.length; index += 2) {
    const line = parts[index]!;
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (marker) {
      if (!fence) fence = { marker: marker[1]![0]!, length: marker[1]!.length };
      else if (marker[1]![0] === fence.marker && marker[1]!.length >= fence.length && !marker[2]!.trim()) fence = null;
      continue;
    }
    if (!fence) parts[index] = rewriteOutsideInlineCode(line, rewrite);
  }
  return parts.join('');
}

function rewriteOutsideInlineCode(line: string, rewrite: (segment: string) => string): string {
  let result = '';
  let cursor = 0;
  let segmentStart = 0;
  while (cursor < line.length) {
    if (line[cursor] !== '`') {
      cursor++;
      continue;
    }
    let endTicks = cursor + 1;
    while (line[endTicks] === '`') endTicks++;
    const delimiter = line.slice(cursor, endTicks);
    let closing = line.indexOf(delimiter, endTicks);
    while (closing >= 0 && (line[closing - 1] === '`' || line[closing + delimiter.length] === '`'))
      closing = line.indexOf(delimiter, closing + 1);
    if (closing < 0) {
      cursor = endTicks;
      continue;
    }
    result += rewrite(line.slice(segmentStart, cursor)) + line.slice(cursor, closing + delimiter.length);
    cursor = closing + delimiter.length;
    segmentStart = cursor;
  }
  result += rewrite(line.slice(segmentStart));
  return result;
}

function pathKey(path: string): string {
  const absolute = resolve(path);
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
}
