import { mkdirSync } from 'node:fs';
import { resolveFilePath } from './file-write-core.js';
import { isMemoryDocumentPath, isMemoryIndexPath } from './memory-paths.js';
import { getScratchRoot } from './paths.js';
import { getConfigPath, getSettingsPath } from './settings.js';
import { classifyTrustedPath, samePhysicalPath } from './workspace-scope.js';

/**
 * The Ranite-owned paths the agent may touch without a permission prompt,
 * and the one file it may never touch at all.
 *
 * This module is the single source of truth for both lists. The scope
 * classifier (`trustedRootsFor`), the file tools (`hostPreAuthorized`) and
 * the registry gate all derive from here, so a path cannot be pre-authorized
 * in one place and gated in another, and the secret store cannot be reachable
 * through a tool the ban forgot. The pre-authorized set is deliberately
 * narrow: the agent's scratch tree, its memory documents, and Ranite's own
 * settings file. Everything else in the data directory (sessions, keys,
 * allowlists) still goes through the normal approval policy.
 */
export type HostOwnedKind = 'scratch' | 'memory' | 'settings';

/**
 * Classifies a file tool source against the host-owned set. Accepts the same
 * raw sources the file tools do (absolute, workspace-relative, `~`-prefixed)
 * and resolves them the same way, so the check and the execution agree on
 * the target. Returns null for anything Ranite does not own. Never throws:
 * an unresolvable source is simply not host-owned.
 */
export function classifyHostOwnedPath(source: string, workspaceRoot: string): HostOwnedKind | null {
  const trimmed = source.trim();
  if (!trimmed) return null;
  if (isMemoryIndexPath(trimmed, workspaceRoot) || isMemoryDocumentPath(trimmed, workspaceRoot)) return 'memory';
  let absolute: string;
  try {
    absolute = resolveFilePath(trimmed, workspaceRoot);
  } catch {
    return null;
  }
  try {
    if (samePhysicalPath(absolute, getSettingsPath())) return 'settings';
  } catch {
    // Fall through to the scratch check.
  }
  try {
    if (classifyTrustedPath(absolute, [getScratchRoot()]) === 'workspace') return 'scratch';
  } catch {
    // An unclassifiable source is not host-owned.
  }
  return null;
}

/**
 * Provisions the host-owned roots that must exist for classification to be
 * stable. The scratch root is dated, so on a fresh day (or machine) it does
 * not exist yet; creating it here means the first write of the day already
 * classifies instead of failing closed into an approval prompt. Best-effort:
 * when the directory cannot be created the classifiers still compare
 * missing-tolerantly, so provisioning must never fail session startup.
 */
export function ensureHostOwnedRoots(): void {
  try {
    mkdirSync(getScratchRoot(), { recursive: true });
  } catch {
    // Classification does not depend on existence; see above.
  }
}

/**
 * True when a resolved absolute target is Ranite's secret store. The agent
 * may never read, write, edit, or search it — no approval mode, whitelist,
 * or pre-authorization overrides this. The host reads the file directly in
 * code, never through a tool, so nothing legitimate needs the tool path.
 * Unresolvable input is not forbidden (it cannot be proven to be the store);
 * it stays on the normal gated path instead.
 */
export function isForbiddenHostPath(target: string): boolean {
  try {
    return samePhysicalPath(target, getConfigPath());
  } catch {
    return false;
  }
}
