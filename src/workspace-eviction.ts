export interface IdleWorkspaceCandidate {
  key: string;
  lastActivityAt: number;
}

export interface WorkspaceEvictionPolicy {
  now: number;
  /** A workspace younger than this is never evicted, so a detach can be followed by an attach. */
  minIdleMs: number;
  idleTtlMs: number;
  maxIdle: number;
}

/** Selects resident workspaces to unload: expired ones plus the least recently used under pressure. */
export function selectIdleWorkspacesToEvict(candidates: readonly IdleWorkspaceCandidate[], policy: WorkspaceEvictionPolicy): string[] {
  const expired: string[] = [];
  const retained: IdleWorkspaceCandidate[] = [];
  for (const candidate of candidates) {
    const idleMs = policy.now - candidate.lastActivityAt;
    if (idleMs < policy.minIdleMs) continue;
    if (idleMs >= policy.idleTtlMs) expired.push(candidate.key);
    else retained.push(candidate);
  }
  const overflow = Math.max(0, retained.length - Math.max(0, policy.maxIdle));
  retained.sort((left, right) => left.lastActivityAt - right.lastActivityAt || left.key.localeCompare(right.key));
  return [...expired, ...retained.slice(0, overflow).map((candidate) => candidate.key)];
}
