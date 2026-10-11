/**
 * One definition of what counts as sensitive, shared by the audit ledger, the
 * auto-review prompt and every notifier. A key is classified the same way
 * wherever tool data is copied, so policy changes live in one file instead of
 * drifting between copies.
 *
 * Text-level detection is delegated to `secret-scan.ts` (the maintained secretlint rule set);
 * this module owns the structural half: which keys name credentials, which values are media
 * payloads, and how a tool result is rewritten before it travels on.
 */

import { redactSecrets } from './secret-scan.js';

const SECRET_KEY =
  /api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|auth(?:orization)?[-_ ]?token|id[-_ ]?token|bearer|(?<![a-z0-9])token(?![a-z0-9])|secret|password|passwd|credential|authorization|cookie|private[-_ ]?key/i;
const MEDIA_KEY = /base64|image|audio|video|blob|bytes/i;
/**
 * A short string under a media key is a path, name or count; only a large or
 * embedded value is a payload whose content must not be copied around.
 */
export const MEDIA_PAYLOAD_MIN_CHARS = 2_048;
/** Strings longer than this are treated as payloads, not prose; scanning them is noise. */
const MAX_SCANNABLE_STRING_CHARS = 2_000_000;
/** Tool result parts that carry binary payloads the model still needs to receive intact. */
const MEDIA_PART_TYPES = new Set(['image-data', 'file-data']);

export type SensitiveEntryKind = 'secret' | 'media';

/** Classifies one key/value pair; `media` requires a value that is actually a payload. */
export function classifySensitiveEntry(key: string, value: unknown): SensitiveEntryKind | null {
  if (SECRET_KEY.test(key)) return 'secret';
  if (MEDIA_KEY.test(key) && isMediaPayload(value)) return 'media';
  return null;
}

function isMediaPayload(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  if (/^data:[a-z0-9.+-]+\/[a-z0-9.+-]+;base64,/i.test(value)) return true;
  return value.length >= MEDIA_PAYLOAD_MIN_CHARS;
}

export function redactSensitive(value: unknown, depth = 0): unknown {
  if (depth > 12) return '[depth limit]';
  if (typeof value === 'string') return redactSensitiveText(value);
  if (Array.isArray(value)) return value.slice(0, 200).map((item) => redactSensitive(item, depth + 1));
  if (value !== null && typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value).slice(0, 200)) {
      const kind = classifySensitiveEntry(key, nested);
      if (kind === 'secret') output[key] = '[redacted]';
      else if (kind === 'media') output[key] = `[media payload omitted; ${(nested as string).length} chars]`;
      else output[key] = redactSensitive(nested, depth + 1);
    }
    return output;
  }
  return value;
}

export function redactSensitiveText(value: string): string {
  return redactSecrets(value);
}

/**
 * Rewrites a tool result the moment it leaves the tool, before it reaches the model, the visible
 * transcript, the activity ledger, or a notification. Credential values detected anywhere in the
 * result become `[redacted]`; media payloads (image/file data) are passed through untouched
 * because the model still has to receive them.
 */
export function redactToolOutput(value: unknown): unknown {
  return redactValue(value, 0);
}

function redactValue(value: unknown, depth: number): unknown {
  if (depth > 12) return value;
  if (typeof value === 'string') {
    if (value.length > MAX_SCANNABLE_STRING_CHARS || /^data:[a-z0-9.+-]+\/[a-z0-9.+-]+;base64,/i.test(value)) return value;
    return redactSecrets(value);
  }
  if (Array.isArray(value)) return value.slice(0, 200).map((item) => redactValue(item, depth + 1));
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const mediaPart = MEDIA_PART_TYPES.has(String(record.type));
    const output: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(record).slice(0, 200)) {
      const kind = classifySensitiveEntry(key, nested);
      if (kind === 'secret') output[key] = '[redacted]';
      // Media payloads belong to the model - an image it just loaded or a file attachment - so
      // they pass through unscanned instead of being replaced the way audit copies do.
      else if (kind === 'media' || (mediaPart && key === 'data')) output[key] = nested;
      else output[key] = redactValue(nested, depth + 1);
    }
    return output;
  }
  return value;
}
