import { createHash } from 'node:crypto';
import { lstatSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { getDataPath } from './paths.js';

export interface MemoryPaths {
  root: string;
  indexFile: string;
  workspaceKey: string;
  userFile: string;
  userTopicsDirectory: string;
  workspaceDirectory: string;
  workspaceFile: string;
  workspaceTopicsDirectory: string;
}

/** Shared path contract for the agent prompt and the session runtime. */
export function getMemoryPaths(workspaceRoot = process.cwd()): MemoryPaths {
  const absoluteWorkspace = resolve(workspaceRoot);
  let stableWorkspace = absoluteWorkspace;
  try {
    stableWorkspace = realpathSync(absoluteWorkspace);
  } catch {
    // A not-yet-created workspace still gets a stable key from its absolute path.
  }
  if (process.platform === 'win32') stableWorkspace = stableWorkspace.toLowerCase();

  const root = getDataPath('MEMORY');
  const key = createHash('sha256').update(stableWorkspace).digest('hex').slice(0, 24);
  const workspaceDirectory = resolve(root, 'workspaces', key);
  return {
    root,
    indexFile: resolve(root, 'MEMORY.md'),
    workspaceKey: key,
    userFile: resolve(root, 'user', 'profile.md'),
    userTopicsDirectory: resolve(root, 'user', 'notes'),
    workspaceDirectory,
    workspaceFile: resolve(workspaceDirectory, 'profile.md'),
    workspaceTopicsDirectory: resolve(workspaceDirectory, 'notes'),
  };
}

/** The only index is MEMORY.md. The remaining Markdown files are source notes. */
export function isMemoryIndexPath(source: string, workspaceRoot = process.cwd()): boolean {
  const paths = getMemoryPaths(workspaceRoot);
  const requested = resolveMemoryPath(source, workspaceRoot);
  return requested !== null && samePath(requested, paths.indexFile) && !hasLinkedComponent(paths.root, requested);
}

export interface MemoryDocumentPath {
  path: string;
  kind: 'profile' | 'note';
  scope: 'user' | `workspace:${string}`;
  notePath: string | null;
}

/**
 * Storage identity comes from the folder; frontmatter cannot change its scope.
 * The managed tree is structural: a symlinked component inside it would let one
 * scope masquerade as another, so such paths are refused rather than resolved.
 */
export function getMemoryDocumentPath(source: string, workspaceRoot = process.cwd()): MemoryDocumentPath | null {
  const paths = getMemoryPaths(workspaceRoot);
  const target = resolveMemoryPath(source, workspaceRoot);
  if (target === null || !target.toLowerCase().endsWith('.md')) return null;
  if (!isWithin(target, paths.root) || hasLinkedComponent(paths.root, target)) return null;
  if (samePath(target, paths.userFile)) return { path: target, kind: 'profile', scope: 'user', notePath: null };
  if (isWithin(target, paths.userTopicsDirectory))
    return { path: target, kind: 'note', scope: 'user', notePath: relative(paths.userTopicsDirectory, target) };
  const parts = relative(paths.root, target).split(sep);
  const workspaceKey = parts[1]?.toLowerCase() ?? '';
  if (parts[0]?.toLowerCase() !== 'workspaces' || !/^[a-f0-9]{24}$/.test(workspaceKey)) return null;
  const scope = `workspace:${workspaceKey}` as const;
  if (parts.length === 3 && parts[2]?.toLowerCase() === 'profile.md') return { path: target, kind: 'profile', scope, notePath: null };
  if (parts[2]?.toLowerCase() === 'notes' && parts.length >= 4)
    return { path: target, kind: 'note', scope, notePath: parts.slice(3).join(sep) };
  return null;
}

export function isWithinMemoryRoot(source: string, workspaceRoot = process.cwd()): boolean {
  const target = resolveMemoryPath(source, workspaceRoot);
  return target !== null && isWithin(target, getMemoryPaths(workspaceRoot).root);
}

/** Source notes live only in Ranite's user or active-workspace memory scopes. */
export function isMemoryDocumentPath(source: string, workspaceRoot = process.cwd()): boolean {
  const document = getMemoryDocumentPath(source, workspaceRoot);
  return document !== null && (document.scope === 'user' || document.scope === `workspace:${getMemoryPaths(workspaceRoot).workspaceKey}`);
}

/**
 * True when any component between the managed root and the target is a symlink.
 * The root itself may be relocated; its internal layout may not, or scope
 * classification stops meaning what it says.
 */
function hasLinkedComponent(root: string, target: string): boolean {
  const relativePath = relative(root, target);
  if (relativePath === '') return false;
  let current = root;
  for (const part of relativePath.split(sep)) {
    if (part === '..' || part === '.') return true;
    current = join(current, part);
    try {
      if (lstatSync(current).isSymbolicLink()) return true;
    } catch (error) {
      return !isMissingPath(error);
    }
  }
  return false;
}

function isMissingPath(error: unknown): boolean {
  return !!error && typeof error === 'object' && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT';
}

function resolveMemoryPath(source: string, workspaceRoot: string): string | null {
  try {
    const expanded = source === '~' ? homedir() : source.replace(/^~(?=[/\\])/, () => homedir());
    return resolve(workspaceRoot, expanded);
  } catch {
    return null;
  }
}

function isWithin(target: string, parent: string): boolean {
  const normalizedTarget = normalize(target);
  const normalizedParent = normalize(parent);
  const difference = relative(normalizedParent, normalizedTarget);
  if (isAbsolute(difference)) return false;
  if (normalizedTarget === normalizedParent) return true;
  return normalizedTarget.startsWith(`${normalizedParent}${process.platform === 'win32' ? '\\' : '/'}`);
}

function samePath(left: string | null, right: string): boolean {
  return left !== null && normalize(left) === normalize(right);
}

function normalize(path: string): string {
  const normalized = resolve(path);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}
