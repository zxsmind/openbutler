import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ActivityLedger, type ObservedEventInput } from '../../src/activity-ledger.js';
import {
  ScheduleRunner,
  assembleWakeText,
  describeSchedule,
  generateScheduleId,
  nextDailyOccurrence,
  normalizeScheduleTrigger,
  readScheduleRuntime,
  writeScheduleError,
  writeScheduleRunFinished,
  writeScheduleRunStarted,
} from '../../src/tools/schedule.js';
import type { ScheduleState } from '../../src/settings.js';

let ledger: ActivityLedger;
let runner: ScheduleRunner | undefined;

beforeEach(() => {
  ledger = new ActivityLedger(':memory:');
});

afterEach(() => {
  runner?.close();
  runner = undefined;
  ledger.close();
  vi.useRealTimers();
});

const makeSchedule = (trigger: ScheduleState['trigger'], extra?: Partial<ScheduleState>): ScheduleState => ({
  id: 'task-1',
  name: 'Nightly check',
  enabled: true,
  workspaceRoot: '/tmp/workspace',
  originSessionId: 'session-1',
  instruction: 'Check thecosa and report. This is a 3-run job: on the 3rd run, finish and disable this schedule.',
  trigger,
  ...extra,
});

describe('nextDailyOccurrence', () => {
  it('picks today when the time is ahead, tomorrow when past', () => {
    // Monday 2026-01-05 10:00 UTC.
    const morning = Date.UTC(2026, 0, 5, 10, 0);
    expect(nextDailyOccurrence(morning, '12:00', undefined, 'UTC')).toEqual({
      atMs: Date.UTC(2026, 0, 5, 12, 0),
      shifted: false,
    });
    expect(nextDailyOccurrence(morning, '02:00', undefined, 'UTC')).toEqual({
      atMs: Date.UTC(2026, 0, 6, 2, 0),
      shifted: false,
    });
  });

  it('honors a weekday filter', () => {
    const monday = Date.UTC(2026, 0, 5, 10, 0);
    // Tuesday only (2): tomorrow.
    expect(nextDailyOccurrence(monday, '02:00', [2], 'UTC').atMs).toBe(Date.UTC(2026, 0, 6, 2, 0));
    // Monday only (1): next week, same time.
    expect(nextDailyOccurrence(monday, '02:00', [1], 'UTC').atMs).toBe(Date.UTC(2026, 0, 12, 2, 0));
  });

  it('moves a daylight-saving gap forward with a shifted flag', () => {
    // America/New_York springs forward on 2026-03-08: 02:00–03:00 never happens.
    const midnight = Date.parse('2026-03-08T05:00:00Z'); // 00:00 EST.
    const occurrence = nextDailyOccurrence(midnight, '02:30', undefined, 'America/New_York');
    expect(occurrence.shifted).toBe(true);
    expect(occurrence.atMs).toBe(Date.parse('2026-03-08T07:00:00Z')); // 03:00 EDT.
  });

  it('rejects a malformed time', () => {
    expect(() => nextDailyOccurrence(Date.now(), '2am', undefined, 'UTC')).toThrow('"HH:MM"');
  });
});

describe('generateScheduleId', () => {
  it('slugs the name and guarantees uniqueness', () => {
    const first = generateScheduleId('Nightly DB Check!', new Set());
    expect(first).toMatch(/^nightly-db-check-[0-9a-f]{4}$/);
    const second = generateScheduleId('Nightly DB Check!', new Set([first]));
    expect(second).toMatch(/^nightly-db-check-[0-9a-f]{4}$/);
    expect(second).not.toBe(first);
  });

  it('falls back to schedule for an empty name', () => {
    expect(generateScheduleId('!!!', new Set())).toMatch(/^schedule-[0-9a-f]{4}$/);
  });
});

describe('scheduleWorkspaceScope', () => {
  let dataDir: string;
  let home: string;
  let away: string;
  let scopeOf: (input: Record<string, unknown>, sessionWorkspaceRoot: string) => string;

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'openbutler-task-scope-'));
    home = mkdtempSync(join(tmpdir(), 'openbutler-task-home-'));
    away = mkdtempSync(join(tmpdir(), 'openbutler-task-away-'));
    vi.stubEnv('OPENBUTLER_DATA_DIR', dataDir);
    // Settings paths resolve at module load, so the scope check needs a
    // module instance loaded after the data dir moves.
    vi.resetModules();
    scopeOf = (await import('../../src/tools/schedule.js')).scheduleWorkspaceScope;
    writeFileSync(
      join(dataDir, 'settings.yaml'),
      [
        'schedules:',
        '  - id: home-task',
        '    name: Home',
        `    workspaceRoot: ${JSON.stringify(home)}`,
        '    instruction: Do it.',
        '    trigger: {adapter: manual, options: {}}',
        '  - id: away-task',
        '    name: Away',
        `    workspaceRoot: ${JSON.stringify(away)}`,
        '    instruction: Do it.',
        '    trigger: {adapter: manual, options: {}}',
        '',
      ].join('\n'),
      'utf8',
    );
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
    rmSync(away, { recursive: true, force: true });
  });

  it('scopes mutations to the task workspace like files', () => {
    expect(scopeOf({ action: 'list' }, home)).toBe('workspace');
    expect(scopeOf({ action: 'add', schedule: { workspaceRoot: home } }, home)).toBe('workspace');
    expect(scopeOf({ action: 'add', schedule: {} }, home)).toBe('workspace');
    expect(scopeOf({ action: 'add', schedule: { workspaceRoot: away } }, home)).toBe('outside');
    expect(scopeOf({ action: 'run', scheduleId: 'home-task' }, home)).toBe('workspace');
    expect(scopeOf({ action: 'disable', scheduleId: 'away-task' }, home)).toBe('outside');
    expect(scopeOf({ action: 'run', scheduleId: 'ghost' }, home)).toBe('unknown');
    expect(scopeOf({ action: 'run' }, home)).toBe('unknown');
  });

  it('auto-approves same-workspace mutations through the registry gate', async () => {
    const { ToolRegistry } = await import('../../src/tools/registry.js');
    const { createScheduleTool } = await import('../../src/tools/schedule.js');
    const registry = new ToolRegistry();
    registry.register(createScheduleTool(home, async () => ({ status: 'completed' })));
    const approve = vi.fn(async () => true);
    const built = await registry.createModelTools({ approve, approvalMode: 'workspace', onResult: () => {} });
    const run = (input: Record<string, unknown>, id: string) => built.tools.schedule!.execute!(input, { toolCallId: id, messages: [] });
    await run({ action: 'add', schedule: { name: 'X', instruction: 'Do.', trigger: { adapter: 'manual', options: {} } } }, 'c1');
    expect(approve).not.toHaveBeenCalled();
    await run({ action: 'disable', scheduleId: 'home-task' }, 'c2');
    expect(approve).not.toHaveBeenCalled();
    await run({ action: 'disable', scheduleId: 'away-task' }, 'c3');
    expect(approve).toHaveBeenCalledTimes(1);
  });
});

describe('normalizeScheduleTrigger', () => {
  it('converts an explicit offset to server-local wall time', () => {
    const normalized = normalizeScheduleTrigger({ adapter: 'at', options: { at: '2030-01-01T12:00:00+02:00' } });
    // Same instant, no offset suffix left.
    expect(Date.parse(normalized.options.at as string)).toBe(Date.parse('2030-01-01T12:00:00+02:00'));
    expect(normalized.options.at).not.toMatch(/(?:Z|[+-]\d{2}:?\d{2})$/);
  });

  it('leaves server-local input untouched', () => {
    const normalized = normalizeScheduleTrigger({ adapter: 'window', options: { from: '2030-01-01T08:00', to: '2030-01-01T11:00' } });
    expect(normalized.options).toEqual({ from: '2030-01-01T08:00', to: '2030-01-01T11:00' });
  });
});

describe('describeSchedule', () => {
  it('summarizes every adapter in server-local terms', () => {
    const now = Date.parse('2030-06-01T10:00:00Z');
    expect(describeSchedule(makeSchedule({ adapter: 'manual', options: {} }), now)).toEqual({ human: 'on demand', nextDueAt: null });
    expect(describeSchedule(makeSchedule({ adapter: 'interval', options: { everySeconds: 1800 } }), now, now + 900_000)).toEqual({
      human: 'every 30m',
      nextDueAt: now + 900_000,
    });
    expect(describeSchedule(makeSchedule({ adapter: 'filesystem', options: { path: '/data' } }), now)).toEqual({
      human: 'on changes under /data',
      nextDueAt: null,
    });
    expect(describeSchedule(makeSchedule({ adapter: 'memory_pressure', options: { usedPercent: 90 } }), now)).toEqual({
      human: 'when memory used ≥ 90%',
      nextDueAt: null,
    });
  });
});

describe('assembleWakeText', () => {
  const base = {
    schedule: makeSchedule({ adapter: 'interval', options: { everySeconds: 3600 } }),
    scheduleHuman: 'every 1h',
    runNumber: 3,
    facts: { scheduledAt: '2030-06-01T08:00:00' },
  };

  it('follows the normative order with a LATE block when late', () => {
    const text = assembleWakeText({
      ...base,
      scheduledAtMs: Date.parse('2030-06-01T08:00:00Z'),
      nowMs: Date.parse('2030-06-01T10:30:00Z'),
    });
    const lines = text.split('\n');
    expect(lines[0]).toBe('Schedule "Nightly check" (task-1).');
    expect(lines[1]).toBe('Schedule: every 1h.');
    expect(lines[2]).toBe('This is run #3. No previous run.');
    expect(lines[3]).toMatch(/^LATE: scheduled for .* starting .* \(2h 30m late\)\. Adjust for staleness and say so in the report\.$/);
    expect(lines[4]).toMatch(/^Trigger facts \(untrusted observations/);
    expect(lines[5]).toBe('Instruction:');
    expect(lines[6]).toBe(base.schedule.instruction);
    expect(lines[lines.length - 1]).toMatch(/^Close this run with a report message/);
  });

  it('omits LATE within the grace period and reports the previous run', () => {
    const text = assembleWakeText({
      ...base,
      lastResult: 'completed',
      lastRunAtMs: Date.parse('2030-06-01T07:00:00Z'),
      scheduledAtMs: Date.parse('2030-06-01T08:00:00Z'),
      nowMs: Date.parse('2030-06-01T08:00:30Z'),
    });
    expect(text).not.toContain('LATE:');
    expect(text).toContain('This is run #3. Last run: completed (1h 0m).');
  });

  it('notes a daylight-saving shift on the schedule line', () => {
    const text = assembleWakeText({ ...base, clockShift: true, nowMs: Date.parse('2030-06-01T08:00:00Z') });
    expect(text).toContain('Schedule: every 1h (clock shifted for daylight saving).');
  });
});

describe('durable schedule runtime', () => {
  it('starts idle, tracks a run, and clears the error on success', () => {
    expect(readScheduleRuntime(ledger, 'task-1')).toEqual({ status: 'idle', runCount: 0 });
    writeScheduleRunStarted(ledger, 'task-1', 1_000);
    expect(readScheduleRuntime(ledger, 'task-1').status).toBe('running');
    writeScheduleRunFinished(ledger, 'task-1', { result: 'completed', report: 'All quiet.' });
    expect(readScheduleRuntime(ledger, 'task-1')).toEqual({
      status: 'idle',
      lastRunAt: 1_000,
      lastResult: 'completed',
      runCount: 1,
      lastReport: 'All quiet.',
    });
  });

  it('keeps the error and bumps the counter on failure', () => {
    writeScheduleRunStarted(ledger, 'task-1', 1_000);
    writeScheduleRunFinished(ledger, 'task-1', { result: 'failed', error: 'boom' });
    const runtime = readScheduleRuntime(ledger, 'task-1');
    expect(runtime).toMatchObject({ status: 'idle', lastResult: 'failed', lastError: 'boom', runCount: 1 });
    writeScheduleRunStarted(ledger, 'task-1', 2_000);
    writeScheduleRunFinished(ledger, 'task-1', { result: 'completed', report: 'ok' });
    const recovered = readScheduleRuntime(ledger, 'task-1');
    expect(recovered.runCount).toBe(2);
    expect(recovered.lastError).toBeUndefined();
    expect('lastError' in recovered).toBe(false);
  });

  it('caps a long report at 8000 characters, head-kept', () => {
    writeScheduleRunStarted(ledger, 'task-1', 1_000);
    writeScheduleRunFinished(ledger, 'task-1', { result: 'completed', report: `${'x'.repeat(9_000)}tail` });
    const report = readScheduleRuntime(ledger, 'task-1').lastReport ?? '';
    expect([...report].length).toBe(8_000);
    expect(report.endsWith('tail')).toBe(false);
  });

  it('marks a missing workspace with no retry loop behind it', () => {
    writeScheduleError(ledger, 'task-1', 'Workspace is missing: /gone');
    expect(readScheduleRuntime(ledger, 'task-1')).toMatchObject({ status: 'error', statusError: 'Workspace is missing: /gone' });
  });
});

describe('one-shot completion from event history', () => {
  it('fires a past window immediately as late, once', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2030-06-01T12:00:00Z'));
    const published: unknown[] = [];
    runner = new ScheduleRunner(
      ledger,
      async (event: ObservedEventInput) => {
        published.push(event);
        ledger.insertEvent(event);
      },
      () => {},
    );
    const requested = makeSchedule({ adapter: 'window', options: { from: '2030-06-01T08:00:00', to: '2030-06-01T11:00:00' } });
    await runner.reload([requested]);
    await vi.advanceTimersByTimeAsync(0);
    expect(published).toHaveLength(1);
    expect((published[0] as { payload: { facts: { scheduledAt: string } } }).payload.facts.scheduledAt).toBe(
      new Date(Date.parse('2030-06-01T08:00:00')).toISOString(),
    );
    // A reload with the run recorded never fires twice.
    const statuses = runner.listStatuses();
    expect(statuses).toHaveLength(1);
    await runner.reload([requested]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(published).toHaveLength(1);
  });

  it('retries an interrupted one-shot on reload instead of dropping it', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2030-06-01T12:00:00Z'));
    const publish = vi.fn(async () => {});
    runner = new ScheduleRunner(ledger, publish, () => {});
    const requested = makeSchedule({ adapter: 'at', options: { at: '2030-06-01T08:00:00' } });
    const inserted = ledger.insertEvent({
      source: 'schedule:at',
      kind: 'schedule.at',
      dedupeKey: `schedule:${requested.id}:at:${Date.parse('2030-06-01T08:00:00')}`,
      payload: { scheduleId: requested.id, facts: {} },
    });
    ledger.claimEvent(inserted.id);
    ledger.setEventState(inserted.id, 'interrupted', 'Host stopped.');
    await runner.reload([requested]);
    await vi.advanceTimersByTimeAsync(0);
    expect(ledger.getEvent(inserted.id)?.status).toBe('pending');
  });

  it('reports completed for a delivered one-shot and arms nothing', async () => {
    vi.useFakeTimers();
    const publish = vi.fn(async () => {});
    runner = new ScheduleRunner(ledger, publish, () => {});
    const requested = makeSchedule({ adapter: 'at', options: { at: '2030-06-01T08:00:00' } });
    const inserted = ledger.insertEvent({
      source: 'schedule:at',
      kind: 'schedule.at',
      dedupeKey: `schedule:${requested.id}:at:${Date.parse('2030-06-01T08:00:00')}`,
      payload: { scheduleId: requested.id, facts: {} },
    });
    ledger.claimEvent(inserted.id);
    ledger.setEventState(inserted.id, 'delivered');
    await runner.reload([requested]);
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(publish).not.toHaveBeenCalled();
    expect(runner.listStatuses()).toEqual([{ id: 'task-1', state: 'completed' }]);
  });
});
