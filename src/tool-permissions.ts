import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { getDataPath } from './paths.js';
import type { ToolCallRequest } from './tools/registry.js';

const PERMISSIONS_FILE = getDataPath('tool-whitelist.json');

/** One remembered call: the hash that decides it, plus enough text to recognise it. */
export interface RememberedPermission {
  hash: string;
  label: string;
  at: number;
}

export function isToolRequestWhitelisted(workspaceRoot: string, request: ToolCallRequest): boolean {
  try {
    return readEntries().has(requestFingerprint(workspaceRoot, request));
  } catch {
    return false;
  }
}

export function rememberToolRequest(workspaceRoot: string, request: ToolCallRequest): void {
  let rules: Map<string, RememberedPermission>;
  try {
    rules = readEntries();
  } catch {
    // A damaged allowlist must not block an explicit "always allow". Keep the unreadable file for
    // inspection and start a fresh list; forgetting rules only means the user approves again.
    try {
      renameSync(PERMISSIONS_FILE, `${PERMISSIONS_FILE}.corrupt`);
    } catch {
      // The file may be unreadable yet not movable; the rewrite below still replaces it.
    }
    rules = new Map();
  }
  const hash = requestFingerprint(workspaceRoot, request);
  rules.set(hash, { hash, label: describeRequest(request), at: Date.now() });
  writeEntries(rules);
}

/** How many exact requests the owner has already allowed. */
export function countRememberedPermissions(): number {
  return readEntries().size;
}

/** The remembered calls, newest first, so the owner can see and revoke them. */
export function listRememberedPermissions(): RememberedPermission[] {
  return [...readEntries().values()].sort((left, right) => right.at - left.at);
}

/** Drops one remembered call. Returns false when the hash was not there. */
export function forgetRememberedPermission(hash: string): boolean {
  const rules = readEntries();
  if (!rules.delete(hash)) return false;
  writeEntries(rules);
  return true;
}

/** A short, human-readable identity for an approved call. */
function describeRequest(request: ToolCallRequest): string {
  const input = request.input && typeof request.input === 'object' ? (request.input as Record<string, unknown>) : {};
  const parts: string[] = [];
  for (const key of ['command', 'path', 'file_path', 'url', 'query', 'pattern', 'name']) {
    const value = input[key];
    if (typeof value === 'string' && value.trim()) parts.push(value.trim());
  }
  const detail = parts.length > 0 ? parts.join(' ') : stableJson(input);
  return `${request.name}: ${detail}`.slice(0, 160);
}

function readEntries(): Map<string, RememberedPermission> {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(PERMISSIONS_FILE, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Map();
    throw new Error('The saved tool allowlist could not be read.');
  }
  if (!raw || typeof raw !== 'object' || !('version' in raw) || !('rules' in raw) || !Array.isArray(raw.rules)) {
    throw new Error('The saved tool allowlist is invalid.');
  }
  const entries = new Map<string, RememberedPermission>();
  if (raw.version === 1) {
    // Version 1 kept hashes only. A hash cannot be turned back into the call it
    // came from, so these rows are named by their hash: distinct, honest, and
    // revocable. Anything approved from now on carries its own label.
    for (const rule of raw.rules as unknown[]) {
      if (typeof rule !== 'string' || !/^[a-f0-9]{64}$/.test(rule)) throw new Error('The saved tool allowlist is invalid.');
      entries.set(rule, { hash: rule, label: `Unnamed approval · ${rule.slice(0, 8)}`, at: 0 });
    }
    return entries;
  }
  if (raw.version !== 2) throw new Error('The saved tool allowlist is invalid.');
  for (const rule of raw.rules as unknown[]) {
    if (!rule || typeof rule !== 'object') throw new Error('The saved tool allowlist is invalid.');
    const { hash, label, at } = rule as Record<string, unknown>;
    if (typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash)) throw new Error('The saved tool allowlist is invalid.');
    entries.set(hash, {
      hash,
      label: typeof label === 'string' && label ? label : 'Approved call',
      at: typeof at === 'number' && Number.isFinite(at) ? at : 0,
    });
  }
  return entries;
}

function writeEntries(entries: Map<string, RememberedPermission>): void {
  mkdirSync(dirname(PERMISSIONS_FILE), { recursive: true });
  const temporaryPath = `${PERMISSIONS_FILE}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify({ version: 2, rules: [...entries.values()] }, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  renameSync(temporaryPath, PERMISSIONS_FILE);
}

function requestFingerprint(workspaceRoot: string, request: ToolCallRequest): string {
  const workspace = resolve(workspaceRoot);
  const payload = stableJson({ workspace, providerId: request.providerId, name: request.name, input: request.input });
  return createHash('sha256').update(payload).digest('hex');
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
