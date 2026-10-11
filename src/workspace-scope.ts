import { lstatSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';

export type WorkspaceScope = 'workspace' | 'outside' | 'unknown';

/** Resolve existing symlinks before comparing a tool target to the workspace. */
export function classifyWorkspacePath(path: string, workspaceRoot: string): WorkspaceScope {
  try {
    const root = realpathSync(workspaceRoot);
    const target = resolveThroughExistingParents(path);
    if (!target) return 'unknown';
    return isWithinResolved(target, root) ? 'workspace' : 'outside';
  } catch {
    return 'unknown';
  }
}

/** True when the physically resolved target stays inside the physically resolved parent. */
export function isWithinPhysicalDirectory(target: string, parent: string): boolean {
  const resolvedTarget = resolveThroughExistingParents(target);
  const resolvedParent = resolveThroughExistingParents(parent);
  return resolvedTarget !== null && resolvedParent !== null && isWithinResolved(resolvedTarget, resolvedParent);
}

/** True when both paths physically resolve to the same location. */
export function samePhysicalPath(left: string, right: string): boolean {
  const resolvedLeft = resolveThroughExistingParents(left);
  const resolvedRight = resolveThroughExistingParents(right);
  return resolvedLeft !== null && resolvedRight !== null && normalizePath(resolvedLeft) === normalizePath(resolvedRight);
}

export function resolveThroughExistingParents(path: string): string | null {
  const missing: string[] = [];
  let current = resolve(path);
  while (true) {
    try {
      lstatSync(current);
    } catch (error) {
      if (!isMissingPath(error)) return null;
      const parent = dirname(current);
      if (parent === current) return null;
      missing.push(basename(current));
      current = parent;
      continue;
    }
    try {
      return resolve(realpathSync(current), ...missing.reverse());
    } catch {
      return null;
    }
  }
}

function isMissingPath(error: unknown): boolean {
  return !!error && typeof error === 'object' && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT';
}

function isWithinResolved(target: string, parent: string): boolean {
  const difference = relative(normalizePath(parent), normalizePath(target));
  return difference === '' || (difference !== '..' && !difference.startsWith(`..${sep}`) && !isAbsolute(difference));
}

function normalizePath(path: string): string {
  const absolute = resolve(path);
  return process.platform === 'win32' ? absolute.toLocaleLowerCase('en-US') : absolute;
}
