import { lstatSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { getScratchRoot } from './paths.js';

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

/**
 * Classifies against every root the owner has already trusted for this turn:
 * the directory OpenButler was launched in (or an explicit `--workspace`) and the
 * agent's own scratch area. Any single match keeps the operation inside the
 * approved boundary.
 *
 * Roots resolve missing-tolerantly through existing parents, the same way
 * the target does: a trusted root that does not exist yet (the dated scratch
 * directory on a fresh day) still contains its future children lexically, so
 * the first write of the day classifies instead of failing into `outside`.
 * Only a root that cannot be resolved at all is skipped.
 */
export function classifyTrustedPath(path: string, roots: readonly string[]): WorkspaceScope {
  const target = resolveThroughExistingParents(path);
  if (!target) return 'unknown';
  let resolvedAny = false;
  for (const root of roots) {
    try {
      const resolvedRoot = resolveThroughExistingParents(root);
      if (resolvedRoot === null) continue;
      resolvedAny = true;
      if (isWithinResolved(target, resolvedRoot)) return 'workspace';
    } catch {
      // A root that cannot be resolved cannot contain the target.
    }
  }
  return resolvedAny ? 'outside' : 'unknown';
}

/**
 * The roots that never need a permission prompt: the turn scope plus scratch.
 * This is the scope mechanism's view; the full pre-authorized set (scratch,
 * memory, settings) lives in host-owned-paths.ts, which file tools consult
 * for paths outside every root here.
 */
export function trustedRootsFor(workspaceRoot: string): string[] {
  return [workspaceRoot, getScratchRoot()];
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
