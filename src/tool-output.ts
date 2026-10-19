import { randomUUID } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readdirSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { getDataPath } from './paths.js';

/**
 * Tool output that did not fit in the model-facing result.
 *
 * A tool result is cut to keep the model's context sane, but the cut part is
 * real evidence the agent may still need. Instead of dropping it, the host
 * writes the complete, already-redacted output under the data directory and
 * tells the model where it is, so a follow-up `file_read` gets the rest and
 * nothing needs to be re-derived by guessing at narrower commands.
 *
 * This is host-owned generated data, not the agent's scratch space: the agent
 * may read it without a prompt, it is never a place to write user files, and
 * it expires on its own.
 */
export const TOOL_OUTPUT_INLINE_CHARS = 16_000;
/** Command output is the noisiest source, so it keeps less inline. */
export const TOOL_OUTPUT_COMMAND_CHARS = 8_000;
export const TOOL_OUTPUT_RETENTION_MS = 3 * 24 * 60 * 60_000;
export const TOOL_OUTPUT_MAX_BYTES = 500 * 1024 * 1024;
/** A runaway command cannot fill the disk through one spill file. */
export const TOOL_OUTPUT_MAX_FILE_BYTES = 64 * 1024 * 1024;

const PRUNE_INTERVAL_MS = 60 * 60_000;
let lastPruneAt = 0;

export function getToolOutputRoot(): string {
  return getDataPath('tool-output');
}

function stamp(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function safeToolName(tool: string): string {
  return (
    tool
      .replace(/[^a-zA-Z0-9_.-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'tool'
  );
}

/**
 * Writes one complete tool output and returns its path. The caller keeps
 * `TOOL_OUTPUT_MAX_FILE_BYTES` of it; anything beyond is reported in the
 * returned notice so the truncation stays visible instead of silent.
 */
export function spillToolOutput(input: { sessionId?: string; tool: string; text: string }): {
  path: string;
  savedChars: number;
  droppedChars: number;
} {
  const root = getToolOutputRoot();
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const session = (input.sessionId ?? 'session').replace(/[^a-zA-Z0-9-]+/g, '').slice(0, 8) || 'session';
  const name = `${stamp(new Date())}-${session}-${safeToolName(input.tool)}-${randomUUID().slice(0, 8)}.log`;
  const path = join(root, name);
  const limit = TOOL_OUTPUT_MAX_FILE_BYTES;
  const text = input.text.length > limit ? input.text.slice(0, limit) : input.text;
  writeFileSync(path, text, { encoding: 'utf8', mode: 0o600 });
  pruneToolOutput();
  return { path, savedChars: text.length, droppedChars: input.text.length - text.length };
}

/**
 * Streaming writer for a command's output file. The host keeps only a short
 * inline preview in memory, so this is what makes the tail available at all;
 * it stops at the per-file cap instead of letting one runaway command fill the
 * disk.
 */
export interface ToolOutputWriter {
  readonly path: string;
  write(text: string): void;
  close(): { path: string; savedChars: number; droppedChars: number };
}

export function openToolOutput(input: { sessionId?: string; tool: string }): ToolOutputWriter {
  const root = getToolOutputRoot();
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const session = (input.sessionId ?? 'session').replace(/[^a-zA-Z0-9-]+/g, '').slice(0, 8) || 'session';
  const path = join(root, `${stamp(new Date())}-${session}-${safeToolName(input.tool)}-${randomUUID().slice(0, 8)}.log`);
  const descriptor = openSync(path, 'w', 0o600);
  let savedChars = 0;
  let droppedChars = 0;
  let closed = false;
  return {
    path,
    write(text: string): void {
      if (closed || !text) return;
      const room = TOOL_OUTPUT_MAX_FILE_BYTES - savedChars;
      if (room <= 0) {
        droppedChars += text.length;
        return;
      }
      const chunk = text.length <= room ? text : text.slice(0, room);
      if (chunk.length < text.length) droppedChars += text.length - chunk.length;
      try {
        writeSync(descriptor, chunk);
        savedChars += chunk.length;
      } catch {
        droppedChars += chunk.length;
      }
    },
    close() {
      if (!closed) {
        closed = true;
        closeSync(descriptor);
        pruneToolOutput();
      }
      return { path, savedChars, droppedChars };
    },
  };
}

/** The sentence the model sees next to a truncated result. */
export function toolOutputNotice(path: string, totalChars: number, droppedChars = 0): string {
  const saved =
    droppedChars > 0
      ? ` The saved file was itself capped, ${droppedChars.toLocaleString('en-US')} characters past the cap were not written.`
      : '';
  return `The full output (${totalChars.toLocaleString('en-US')} characters) is saved at ${path}. Read it with file_read using offset/limit, or search it with grep; do not re-run the command to see the rest.${saved}`;
}

/**
 * Deletes spill files older than the retention window, then trims the oldest
 * ones until the directory fits its byte budget. Runs at most once an hour and
 * never throws: cleanup must not fail a tool call.
 */
export function pruneToolOutput(now = Date.now(), options: { force?: boolean; maxBytes?: number } = {}): void {
  if (!options.force && now - lastPruneAt < PRUNE_INTERVAL_MS) return;
  lastPruneAt = now;
  const root = getToolOutputRoot();
  let entries: Array<{ path: string; size: number; modifiedAt: number }>;
  try {
    entries = readdirSync(root)
      .map((name) => {
        const path = join(root, name);
        try {
          const details = statSync(path);
          return details.isFile() ? { path, size: details.size, modifiedAt: details.mtimeMs } : null;
        } catch {
          return null;
        }
      })
      .filter((entry): entry is { path: string; size: number; modifiedAt: number } => entry !== null);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (now - entry.modifiedAt <= TOOL_OUTPUT_RETENTION_MS) continue;
    try {
      rmSync(entry.path, { force: true });
    } catch {
      /* An unremovable file is retried on the next pass. */
    }
  }
  const remaining = entries
    .filter((entry) => now - entry.modifiedAt <= TOOL_OUTPUT_RETENTION_MS)
    .sort((left, right) => left.modifiedAt - right.modifiedAt);
  let total = remaining.reduce((sum, entry) => sum + entry.size, 0);
  for (const entry of remaining) {
    if (total <= (options.maxBytes ?? TOOL_OUTPUT_MAX_BYTES)) break;
    try {
      rmSync(entry.path, { force: true });
      total -= entry.size;
    } catch {
      /* Same as above. */
    }
  }
}
