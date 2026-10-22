/**
 * One logger for the whole machine.
 *
 * Records are JSON lines: a timestamp, a level, an event name and whatever fields
 * the call site knows. Structured first, because a log is read by a program far
 * more often than by a person; the human rendering lives in `formatLogLine` and is
 * used by `ranite logs`.
 *
 * Three rules hold everywhere:
 * - stdout belongs to command output, so logs go to stderr or to a file.
 * - a secret never reaches a sink: every record passes the redactor.
 * - a log call never throws, whatever the sink does.
 */
import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { getDataPath } from './paths.js';

export type LogLevel = 'error' | 'warn' | 'info' | 'debug';

const LEVEL_ORDER: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3 };

export interface LogRecord {
  /** ISO timestamp. */
  ts: string;
  level: LogLevel;
  /** Short, stable event name, e.g. "host.started". */
  event: string;
  [field: string]: unknown;
}

export interface Logger {
  error(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  info(event: string, fields?: Record<string, unknown>): void;
  debug(event: string, fields?: Record<string, unknown>): void;
  /** A logger that carries extra fields into every record it writes. */
  child(fields: Record<string, unknown>): Logger;
}

export type LogSink = (line: string) => void;

const SECRET_KEY = /(key|token|secret|password|passwd|authorization|cookie|credential)/i;
const SECRET_VALUE = [
  /\b(sk|pk|rk)-[A-Za-z0-9_-]{8,}/g,
  /\bBearer\s+[A-Za-z0-9._-]{8,}/gi,
  /\branite_web=[^;\s]+/g,
  /\b[A-Za-z0-9_-]{32,}\b/g,
];

/** Replaces anything that looks like a credential, by key name or by shape. */
export function redact(value: unknown, key?: string): unknown {
  if (key !== undefined && SECRET_KEY.test(key)) return '[redacted]';
  if (typeof value === 'string') {
    let text = value;
    for (const pattern of SECRET_VALUE) text = text.replace(pattern, '[redacted]');
    return text;
  }
  if (Array.isArray(value)) return value.map((item) => redact(item));
  if (value instanceof Error) {
    return {
      name: value.name,
      message: redact(value.message) as string,
      ...(value.stack ? { stack: redact(value.stack.split('\n').slice(0, 6).join('\n')) as string } : {}),
      ...(value.cause === undefined ? {} : { cause: redact(value.cause) }),
    };
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [entryKey, entryValue] of Object.entries(value as Record<string, unknown>)) out[entryKey] = redact(entryValue, entryKey);
    return out;
  }
  return value;
}

export interface LoggerOptions {
  level?: LogLevel;
  sink?: LogSink;
  /** Fields merged into every record. */
  context?: Record<string, unknown>;
}

function envLevel(): LogLevel {
  const raw = (process.env.RANITE_LOG_LEVEL ?? '').toLowerCase();
  return raw === 'error' || raw === 'warn' || raw === 'info' || raw === 'debug' ? (raw as LogLevel) : 'info';
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const level = options.level ?? envLevel();
  const sink: LogSink = options.sink ?? ((line) => process.stderr.write(`${line}\n`));
  const context = options.context ?? {};

  const write = (recordLevel: LogLevel, event: string, fields?: Record<string, unknown>) => {
    if (LEVEL_ORDER[recordLevel] > LEVEL_ORDER[level]) return;
    const record: LogRecord = {
      ts: new Date().toISOString(),
      level: recordLevel,
      event,
      ...(redact({ ...context, ...fields }) as Record<string, unknown>),
    };
    let line: string;
    try {
      line = JSON.stringify(record);
    } catch {
      line = JSON.stringify({ ts: record.ts, level: recordLevel, event, unserializable: true });
    }
    try {
      sink(line);
    } catch {
      /* a broken sink must not break the caller */
    }
  };

  return {
    error: (event, fields) => write('error', event, fields),
    warn: (event, fields) => write('warn', event, fields),
    info: (event, fields) => write('info', event, fields),
    debug: (event, fields) => write('debug', event, fields),
    child: (fields) => createLogger({ level, sink, context: { ...context, ...fields } }),
  };
}

/** A file sink that rotates by size and keeps a bounded number of files. */
export function fileSink(
  path = getDataPath(join('logs', 'ranite.log')),
  { maxBytes = 5 * 1024 * 1024, keep = 3 }: { maxBytes?: number; keep?: number } = {},
): LogSink {
  mkdirSync(dirname(path), { recursive: true });
  return (line) => {
    try {
      if (existsSync(path) && statSync(path).size + line.length + 1 > maxBytes) {
        for (let index = keep - 1; index >= 1; index -= 1) {
          const from = index === 1 ? path : `${path}.${index - 1}`;
          if (existsSync(from)) {
            try {
              renameSync(from, `${path}.${index}`);
            } catch {
              /* keep writing rather than lose the record */
            }
          }
        }
        if (existsSync(`${path}.${keep}`)) rmSync(`${path}.${keep}`, { force: true });
      }
      appendFileSync(path, `${line}\n`, { mode: 0o600 });
    } catch {
      /* logging never fails a caller */
    }
  };
}

/** One record as a person reads it: time, level, event, then the fields. */
export function formatLogLine(record: LogRecord): string {
  const { ts, level, event, ...fields } = record;
  const time = ts.slice(11, 23);
  const rest = Object.entries(fields)
    .map(([key, value]) => `${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`)
    .join(' ');
  return `${time} ${level.toUpperCase().padEnd(5)} ${event}${rest ? ` ${rest}` : ''}`;
}

export function parseLogLine(line: string): LogRecord | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== 'object') return null;
    const record = parsed as Partial<LogRecord>;
    if (typeof record.ts !== 'string' || typeof record.event !== 'string' || typeof record.level !== 'string') return null;
    return record as LogRecord;
  } catch {
    return null;
  }
}
