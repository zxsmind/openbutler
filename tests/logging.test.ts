import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger, fileSink, formatLogLine, parseLogLine, redact } from '../src/logging.js';
import { readLogRecords } from '../src/cli/logs.js';

const collect = () => {
  const lines: string[] = [];
  return { lines, sink: (line: string) => lines.push(line) };
};

describe('logging', () => {
  it('writes one structured record per call', () => {
    const { lines, sink } = collect();
    const log = createLogger({ level: 'debug', sink, context: { process: 'host' } });
    log.info('host.started', { pid: 42 });
    expect(lines).toHaveLength(1);
    const record = parseLogLine(lines[0]!);
    expect(record).toMatchObject({ level: 'info', event: 'host.started', pid: 42, process: 'host' });
    expect(typeof record?.ts).toBe('string');
  });

  it('drops records below the configured level', () => {
    const { lines, sink } = collect();
    const log = createLogger({ level: 'warn', sink });
    log.debug('a');
    log.info('b');
    log.warn('c');
    log.error('d');
    expect(lines.map((line) => parseLogLine(line)?.event)).toEqual(['c', 'd']);
  });

  it('carries child fields into every record', () => {
    const { lines, sink } = collect();
    const log = createLogger({ level: 'debug', sink }).child({ sessionId: 's1' });
    log.child({ turnId: 't1' }).info('turn.started');
    expect(parseLogLine(lines[0]!)).toMatchObject({ sessionId: 's1', turnId: 't1' });
  });

  it('never writes a credential, by key name or by shape', () => {
    const { lines, sink } = collect();
    const log = createLogger({ level: 'debug', sink });
    log.info('provider.call', { apiKey: 'whatever', header: 'Bearer abcdefghijklmnop', note: 'ranite_web=secretvalue' });
    const line = lines[0]!;
    expect(line).not.toContain('whatever');
    expect(line).not.toContain('abcdefghijklmnop');
    expect(line).not.toContain('secretvalue');
    expect(line).toContain('[redacted]');
  });

  it('redacts an error into a readable shape', () => {
    const redacted = redact(new Error('failed with sk-abcdefgh12345678')) as Record<string, unknown>;
    expect(redacted.name).toBe('Error');
    expect(String(redacted.message)).toContain('[redacted]');
    expect(typeof redacted.stack).toBe('string');
  });

  it('survives a sink that throws', () => {
    const log = createLogger({
      level: 'debug',
      sink: () => {
        throw new Error('disk full');
      },
    });
    expect(() => log.error('still.fine')).not.toThrow();
  });

  it('renders a record for a person and parses it back', () => {
    const line = JSON.stringify({ ts: '2026-10-21T12:00:00.000Z', level: 'warn', event: 'team.wake', detail: 'retry' });
    const record = parseLogLine(line)!;
    expect(formatLogLine(record)).toContain('12:00:00.000');
    expect(formatLogLine(record)).toContain('WARN');
    expect(formatLogLine(record)).toContain('team.wake');
    expect(parseLogLine('not json')).toBeNull();
  });

  it('rotates by size and keeps the newest file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ranite-log-'));
    try {
      const path = join(dir, 'ranite.log');
      const sink = fileSink(path, { maxBytes: 120, keep: 2 });
      for (let index = 0; index < 6; index += 1) sink(JSON.stringify({ ts: new Date().toISOString(), level: 'info', event: `e${index}` }));
      const current = readLogRecords(path);
      expect(current.length).toBeGreaterThan(0);
      expect(current.at(-1)?.event).toBe('e5');
      expect(readFileSync(path, 'utf8')).toContain('e5');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
