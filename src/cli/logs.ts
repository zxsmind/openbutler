/** `ranite logs`: read the machine's structured log without opening a file. */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { formatLogLine, parseLogLine, type LogLevel, type LogRecord } from '../logging.js';
import { getDataPath } from '../paths.js';
import type { Parsed } from './args.js';
import * as ui from './ui.js';

const LEVELS: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3 };

export function readLogRecords(path: string): LogRecord[] {
  if (!existsSync(path)) return [];
  const records: LogRecord[] = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const record = parseLogLine(line);
    if (record) records.push(record);
  }
  return records;
}

export async function runLogs(parsed: Parsed): Promise<void> {
  const lines = Number(parsed.flags.get('lines') ?? 100);
  if (!Number.isFinite(lines) || lines < 1 || lines > 100_000) throw new Error('--lines must be between 1 and 100000.');
  const level = (parsed.flags.get('level') ?? 'info') as LogLevel;
  if (!(level in LEVELS)) throw new Error('--level must be error, warn, info, or debug.');
  const event = parsed.flags.get('event');
  const path = parsed.flags.get('file') ?? getDataPath(join('logs', 'ranite.log'));

  let records = readLogRecords(path).filter((record) => LEVELS[record.level] <= LEVELS[level]);
  if (event) records = records.filter((record) => record.event.includes(event));
  const tail = records.slice(-lines);
  if (parsed.booleans.has('json')) {
    for (const record of tail) ui.line(JSON.stringify(record));
    return;
  }
  if (tail.length === 0) {
    ui.line(`No log records at ${path}${event ? ` for event "${event}"` : ''}.`);
    return;
  }
  for (const record of tail) ui.line(formatLogLine(record));
}
