import { afterEach, expect, it, vi } from 'vitest';
import { ShutdownBudget, withDeadline } from '../src/shutdown.js';

function collector(): { lines: string[]; log: (line: string) => void } {
  const lines: string[] = [];
  return { lines, log: (line: string) => void lines.push(line) };
}

afterEach(() => {
  vi.useRealTimers();
});

it('runs a step inside its budget and names it with its duration', async () => {
  const { lines, log } = collector();
  const budget = new ShutdownBudget(10_000, log, 2_500);
  expect(await budget.run('ledger flush', 1_000, async () => undefined)).toBe(true);
  expect(lines).toHaveLength(1);
  expect(lines[0]).toMatch(/^\[shutdown\] ledger flush: done in \d+ms$/);
});

it('reports a failing step instead of rejecting the shutdown', async () => {
  const { lines, log } = collector();
  const budget = new ShutdownBudget(10_000, log, 2_500, (error) => (error instanceof Error ? error.message : String(error)));
  expect(await budget.run('telegram close', 1_000, () => Promise.reject(new Error('socket hosed')))).toBe(false);
  expect(lines[0]).toMatch(/^\[shutdown\] telegram close: failed after \d+ms — socket hosed$/);
});

it('abandons a step that overruns, keeps the shutdown moving and swallows the late outcome', async () => {
  vi.useFakeTimers();
  const { lines, log } = collector();
  const budget = new ShutdownBudget(10_000, log, 2_500);
  let releaseLate!: (error: Error) => void;
  const stuck = budget.run(
    'mcp connections close',
    500,
    () =>
      new Promise<string>((_resolve, reject) => {
        releaseLate = reject;
      }),
  );
  await vi.advanceTimersByTimeAsync(500);
  await expect(stuck).resolves.toBe(false);
  expect(lines[0]).toMatch(/^\[shutdown\] mcp connections close: abandoned after 500ms \(budget 500ms\)$/);
  expect(await budget.run('after', 500, async () => undefined)).toBe(true);
  // The abandoned operation fails later; that must not surface as an unhandled rejection.
  releaseLate(new Error('late failure'));
  await vi.advanceTimersByTimeAsync(1);
});

it('skips later steps once the budget is spent but still runs reserved work', async () => {
  vi.useFakeTimers();
  const { lines, log } = collector();
  const budget = new ShutdownBudget(1_000, log, 500);
  const volatile = budget.run('workspace sessions close', 5_000, () => new Promise<void>(() => undefined));
  await vi.advanceTimersByTimeAsync(1_000);
  await expect(volatile).resolves.toBe(false);
  expect(await budget.run('background events', 500, async () => undefined)).toBe(false);
  expect(lines.some((line) => line.includes('[shutdown] background events: skipped, shutdown budget exhausted'))).toBe(true);
  expect(await budget.run('ledger flush', 400, async () => undefined, { reserve: true })).toBe(true);
  expect(lines.some((line) => /^\[shutdown\] ledger flush: done in \d+ms$/.test(line))).toBe(true);
});

it('hands a caller an error when its deferred load never settles', async () => {
  vi.useFakeTimers();
  const pending = withDeadline(() => new Promise<string>(() => undefined), 250, 'Chat load');
  const assertion = expect(pending).rejects.toThrow('Chat load did not finish within 250 ms.');
  await vi.advanceTimersByTimeAsync(250);
  await assertion;
});

it('returns the value of an operation that finishes in time', async () => {
  await expect(withDeadline(async () => 'ready', 1_000, 'Workspace load')).resolves.toBe('ready');
});

it('swallows the late outcome of an abandoned operation', async () => {
  vi.useFakeTimers();
  let releaseLate!: (error: Error) => void;
  const abandoned = withDeadline(
    () =>
      new Promise<string>((_resolve, reject) => {
        releaseLate = reject;
      }),
    250,
    'Settings reload',
  );
  const assertion = expect(abandoned).rejects.toThrow('Settings reload did not finish within 250 ms.');
  await vi.advanceTimersByTimeAsync(250);
  await assertion;
  releaseLate(new Error('failed after the deadline'));
  await vi.advanceTimersByTimeAsync(1);
});
