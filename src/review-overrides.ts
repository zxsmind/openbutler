import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { getDataPath } from './paths.js';
import type { ToolCallRequest } from './tools/registry.js';
import { autoReviewFingerprint } from './auto-review.js';

const DENIALS_FILE = getDataPath('review-denials.json');
const APPROVALS_FILE = getDataPath('review-approvals.json');
const MAX_DENIALS = 10;
const ENTRY_TTL_MS = 24 * 60 * 60 * 1000;

export interface DeniedAction {
  fingerprint: string;
  workspaceRoot: string;
  providerId: string;
  name: string;
  reason: string;
  deniedAt: number;
}

interface ApprovalMarker {
  fingerprint: string;
  workspaceRoot: string;
  approvedAt: number;
}

/**
 * One-retry overrides for auto-review denials, in the spirit of Codex's
 * `/approve` picker: narrow (the exact denied action), single-use, and still
 * passing through review. Only fingerprints are persisted, never raw tool
 * inputs, so secrets cannot accumulate here.
 */
export function recordDeniedAction(workspaceRoot: string, request: ToolCallRequest, reason: string): void {
  const entry: DeniedAction = {
    fingerprint: autoReviewFingerprint(request),
    workspaceRoot,
    providerId: request.providerId,
    name: request.name,
    reason: reason.slice(0, 500),
    deniedAt: Date.now(),
  };
  const kept = [entry, ...readDenials().filter((existing) => existing.fingerprint !== entry.fingerprint)].slice(0, MAX_DENIALS);
  writeJson(DENIALS_FILE, { version: 1, denials: kept });
}

export function listDeniedActions(): DeniedAction[] {
  return readDenials();
}

/** Moves a denial to a single-use approval marker. Returns the entry or null. */
export function approveDeniedAction(fingerprint: string): DeniedAction | null {
  const denials = readDenials();
  const entry = denials.find((denial) => denial.fingerprint === fingerprint);
  if (!entry) return null;
  writeJson(DENIALS_FILE, { version: 1, denials: denials.filter((denial) => denial.fingerprint !== fingerprint) });
  const markers = readApprovals().filter((marker) => marker.fingerprint !== fingerprint);
  markers.push({ fingerprint, workspaceRoot: entry.workspaceRoot, approvedAt: Date.now() });
  writeJson(APPROVALS_FILE, { version: 1, approvals: markers });
  return entry;
}

/** Consumes a matching one-shot marker. True when the request may retry through review. */
export function consumeApproval(workspaceRoot: string, request: ToolCallRequest): boolean {
  const fingerprint = autoReviewFingerprint(request);
  const markers = readApprovals();
  const match = markers.find((marker) => marker.fingerprint === fingerprint && marker.workspaceRoot === workspaceRoot);
  if (!match) return false;
  writeJson(APPROVALS_FILE, {
    version: 1,
    approvals: markers.filter((marker) => marker !== match),
  });
  return true;
}

function readDenials(): DeniedAction[] {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(DENIALS_FILE, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    quarantine(DENIALS_FILE);
    return [];
  }
  if (!isVersionedList(raw, 'denials')) {
    quarantine(DENIALS_FILE);
    return [];
  }
  const now = Date.now();
  return (raw.denials as DeniedAction[]).filter(
    (entry) =>
      typeof entry?.fingerprint === 'string' &&
      typeof entry?.workspaceRoot === 'string' &&
      typeof entry?.providerId === 'string' &&
      typeof entry?.name === 'string' &&
      typeof entry?.reason === 'string' &&
      typeof entry?.deniedAt === 'number' &&
      now - entry.deniedAt < ENTRY_TTL_MS,
  );
}

function readApprovals(): ApprovalMarker[] {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(APPROVALS_FILE, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    quarantine(APPROVALS_FILE);
    return [];
  }
  if (!isVersionedList(raw, 'approvals')) {
    quarantine(APPROVALS_FILE);
    return [];
  }
  const now = Date.now();
  return (raw.approvals as ApprovalMarker[]).filter(
    (marker) =>
      typeof marker?.fingerprint === 'string' &&
      typeof marker?.workspaceRoot === 'string' &&
      typeof marker?.approvedAt === 'number' &&
      now - marker.approvedAt < ENTRY_TTL_MS,
  );
}

function isVersionedList(raw: unknown, key: string): raw is Record<string, unknown[]> {
  return (
    !!raw &&
    typeof raw === 'object' &&
    (raw as Record<string, unknown>).version === 1 &&
    Array.isArray((raw as Record<string, unknown>)[key])
  );
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  renameSync(temporaryPath, path);
}

function quarantine(path: string): void {
  try {
    renameSync(path, `${path}.corrupt`);
  } catch {
    // The file may be unreadable yet not movable; the next write replaces it.
  }
}
