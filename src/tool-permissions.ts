import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { getDataPath } from './paths.js';
import type { ToolCallRequest } from './tools/registry.js';

const PERMISSIONS_FILE = getDataPath('tool-whitelist.json');

export function isToolRequestWhitelisted(workspaceRoot: string, request: ToolCallRequest): boolean {
  try {
    return readRules().has(requestFingerprint(workspaceRoot, request));
  } catch {
    return false;
  }
}

export function rememberToolRequest(workspaceRoot: string, request: ToolCallRequest): void {
  let rules: Set<string>;
  try {
    rules = readRules();
  } catch {
    // A damaged allowlist must not block an explicit "always allow". Keep the unreadable file for
    // inspection and start a fresh list; forgetting rules only means the user approves again.
    try {
      renameSync(PERMISSIONS_FILE, `${PERMISSIONS_FILE}.corrupt`);
    } catch {
      // The file may be unreadable yet not movable; the rewrite below still replaces it.
    }
    rules = new Set();
  }
  rules.add(requestFingerprint(workspaceRoot, request));
  mkdirSync(dirname(PERMISSIONS_FILE), { recursive: true });
  const temporaryPath = `${PERMISSIONS_FILE}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify({ version: 1, rules: [...rules] }, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  renameSync(temporaryPath, PERMISSIONS_FILE);
}

function readRules(): Set<string> {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(PERMISSIONS_FILE, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Set();
    throw new Error('The saved tool allowlist could not be read.');
  }
  if (
    !raw ||
    typeof raw !== 'object' ||
    !('version' in raw) ||
    raw.version !== 1 ||
    !('rules' in raw) ||
    !Array.isArray(raw.rules) ||
    raw.rules.some((rule) => typeof rule !== 'string' || !/^[a-f0-9]{64}$/.test(rule))
  ) {
    throw new Error('The saved tool allowlist is invalid.');
  }
  return new Set(raw.rules as string[]);
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
