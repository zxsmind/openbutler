import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ActivityLedger, TOOL_ACTION_STATES, type ToolActionUpdate } from '../../src/activity-ledger.js';
import { BackgroundTaskRunner, validateBackgroundTrigger } from '../../src/tools/background.js';
import { ToolRegistry } from '../../src/tools/registry.js';
import type { BackgroundTaskState } from '../../src/settings.js';

let root: string;
let ledger: ActivityLedger;
let runner: BackgroundTaskRunner | undefined;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ranite-background-check-'));
  vi.stubEnv('RANITE_DATA_DIR', root);
  ledger = new ActivityLedger(':memory:');
});
afterEach(() => {
  runner?.close();
  runner = undefined;
  ledger.close();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith('ranite-background-check-'))
    throw new Error('Unsafe fixture cleanup path.');
  rmSync(root, { recursive: true, force: true });
});

const task = (trigger: BackgroundTaskState['trigger']): BackgroundTaskState => ({
  id: 'requested-task',
  name: 'Explicit user task',
  enabled: true,
  workspaceRoot: root,
  originSessionId: '',
  instruction: 'Notify me only if something requires attention.',
  trigger,
});
const action: ToolActionUpdate = {
  requestId: 'action-1',
  sessionId: 'session-1',
  workspaceRoot: 'fixture',
  providerId: 'host',
  name: 'inspect',
  input: { apiKey: 'must-not-be-in-audit', command: 'inspect password=secret', path: 'important.txt' },
  effect: { change: 'none', data: 'local', network: 'none', reversible: 'full', outbound: 'model' },
  state: 'proposed',
};

describe('durable events and actions', () => {
  it('resumes interrupted owner delivery from its receipt while keeping work execution non-replayable', () => {
    const delivery = ledger.insertEvent({
      source: 'notification',
      kind: 'owner.message',
      dedupeKey: 'delivery',
      payload: { messages: ['one', 'two'] },
    });
    const work = ledger.insertEvent({ source: 'telegram', kind: 'message', dedupeKey: 'work', payload: { text: 'Do work' } });
    ledger.claimEvent(delivery.id);
    ledger.claimEvent(work.id);
    ledger.setState(`notification:telegram-next:${delivery.id}`, '1');
    expect(ledger.recoverInterruptedEvents()).toBe(2);
    expect(ledger.getEvent(delivery.id)?.status).toBe('pending');
    expect(ledger.getState(`notification:telegram-next:${delivery.id}`)).toBe('1');
    expect(ledger.getEvent(work.id)?.status).toBe('interrupted');
  });
  it('deduplicates canonical events, claims once, and requires an explicit retry after interruption', () => {
    const event = {
      source: 'telegram',
      kind: 'message',
      dedupeKey: 'telegram:1',
      payload: { text: 'Use token=actual-user-input for this requested action.' },
    };
    const first = ledger.insertEvent(event);
    expect(ledger.insertEvent(event)).toEqual({ id: first.id, inserted: false });
    expect(ledger.getEvent(first.id)?.payload).toEqual(event.payload);
    expect(ledger.claimEvent(first.id)?.attempts).toBe(1);
    expect(ledger.claimEvent(first.id)).toBeNull();
    expect(ledger.recoverInterruptedEvents()).toBe(1);
    expect(ledger.pendingEvents()).toEqual([]);
    expect(ledger.getEvent(first.id)?.status).toBe('interrupted');
    expect(ledger.retryEvent(first.id)).toBe(true);
    expect(ledger.claimEvent(first.id)?.attempts).toBe(2);
  });

  it('keeps append-only action transitions and redacts audit data without changing tool inputs', () => {
    const original = JSON.stringify(action.input);
    for (const state of ['proposed', 'approved', 'started', 'completed'] as const) ledger.recordToolAction({ ...action, state });
    expect(ledger.actionTransitions(action.requestId).map((row) => row.state)).toEqual(['proposed', 'approved', 'started', 'completed']);
    const audit = JSON.stringify(ledger.listActions());
    expect(audit).not.toContain('must-not-be-in-audit');
    expect(audit).not.toContain('password=secret');
    expect(audit).toContain('important.txt');
    expect(JSON.stringify(action.input)).toBe(original);
    expect(() => ledger.recordToolAction({ ...action, requestId: 'never-proposed', state: 'started' })).toThrow('before execution');
    expect(ledger.actionTransitions('never-proposed')).toEqual([]);
  });

  it('persists events and scheduler state across ledger reopen and leaves uncertain actions unreplayed', () => {
    ledger.close();
    const path = join(root, 'state.db');
    ledger = new ActivityLedger(path);
    const event = ledger.insertEvent({ source: 'task:manual', kind: 'requested', dedupeKey: 'task:one', payload: { taskId: 'one' } });
    ledger.setState('cursor', '42');
    ledger.recordToolAction(action);
    ledger.recordToolAction({ ...action, state: 'started' });
    ledger.close();
    ledger = new ActivityLedger(path);
    expect(ledger.getState('cursor')).toBe('42');
    expect(ledger.pendingEvents()[0]?.id).toBe(event.id);
    expect(ledger.recoverInterruptedActions()).toBe(1);
    expect(ledger.listActions()[0]?.error).toContain('do not replay');
    expect(ledger.listActions()[0]?.state).toBe('failed');
  });

  it('stores every declared action state, including the auto-review verdicts', () => {
    ledger.recordToolAction({ ...action, state: 'proposed' });
    for (const state of TOOL_ACTION_STATES.filter((candidate) => candidate !== 'proposed')) {
      expect(() => ledger.recordToolAction({ ...action, state })).not.toThrow();
    }
    expect(ledger.actionTransitions(action.requestId).map((row) => row.state)).toEqual([...TOOL_ACTION_STATES]);
    expect(ledger.listActions()[0]?.state).toBe('cancelled');
  });
});

describe('explicit background subscriptions', () => {
  it('starts no timer or observation by default and validates adapter-specific fields', async () => {
    vi.useFakeTimers();
    vi.resetModules();
    const settings = await import('../../src/settings.js');
    expect(settings.defaultSettings().backgroundTasks).toEqual([]);
    const publish = vi.fn<(event: unknown) => Promise<void>>(async () => {});
    runner = new BackgroundTaskRunner(ledger, publish, () => {});
    await runner.reload(settings.defaultSettings().backgroundTasks);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(86_400_000);
    expect(publish).not.toHaveBeenCalled();
    expect(() => validateBackgroundTrigger({ adapter: 'interval', options: { everySeconds: 10, typo: true } })).toThrow(
      'not a trigger option',
    );
    /* Server-local wall time needs no offset; an offset is converted at creation, not rejected here. */
    expect(() => validateBackgroundTrigger({ adapter: 'at', options: { at: 'not-a-time' } })).toThrow('server-local ISO');
    expect(validateBackgroundTrigger({ adapter: 'at', options: { at: '2030-01-01T12:00:00' } })).toBeUndefined();
    expect(() =>
      validateBackgroundTrigger({ adapter: 'window', options: { from: '2030-01-01T12:00:00', to: '2030-01-01T11:00:00' } }),
    ).toThrow('later than window.from');
    expect(() => validateBackgroundTrigger({ adapter: 'daily', options: { at: '2am' } })).toThrow('"HH:MM"');
    expect(() => validateBackgroundTrigger({ adapter: 'daily', options: { at: '02:00', days: ['funday'] } })).toThrow(
      'mon,tue,wed,thu,fri,sat,sun',
    );
    expect(validateBackgroundTrigger({ adapter: 'daily', options: { at: '02:00', days: ['mon', 'wed'] } })).toBeUndefined();
  });

  it('recovers one overdue interval, then resumes the requested cadence without replaying missed intervals', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2030-01-01T00:00:00Z'));
    const publish = vi.fn<(event: unknown) => Promise<void>>(async () => {});
    runner = new BackgroundTaskRunner(ledger, publish, () => {});
    const requested = task({ adapter: 'interval', options: { everySeconds: 10 } });
    await runner.reload([requested]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(publish).toHaveBeenCalledTimes(1);
    runner.close();
    vi.setSystemTime(new Date('2030-01-02T00:00:00Z'));
    await runner.reload([requested]);
    await vi.advanceTimersByTimeAsync(0);
    expect(publish).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(publish).toHaveBeenCalledTimes(3);
    await runner.reload([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('collects only metadata from an explicitly selected filesystem root', async () => {
    const publish = vi.fn<(event: unknown) => Promise<void>>(async () => {});
    runner = new BackgroundTaskRunner(ledger, publish, () => {});
    await runner.reload([task({ adapter: 'filesystem', options: { path: root, debounceSeconds: 1 } })]);
    writeFileSync(join(root, 'selected-note.txt'), 'PRIVATE FILE CONTENT MUST NOT BE COLLECTED');
    await vi.waitFor(() => expect(publish).toHaveBeenCalled(), { timeout: 4000, interval: 25 });
    const event = publish.mock.calls[0]?.[0];
    expect(JSON.stringify(event)).toContain('selected-note.txt');
    expect(JSON.stringify(event)).not.toContain('PRIVATE FILE CONTENT');
  });
});

describe('execution ledger and background approvals', () => {
  it('does not execute a default-auto-approved tool when a background session requires user approval', async () => {
    const execute = vi.fn(async () => ({ status: 'completed' }));
    const registry = new ToolRegistry();
    registry.register({
      providerId: 'host',
      name: 'inspect',
      description: 'Fixture inspect',
      inputSchema: { type: 'object', properties: {} },
      effect: action.effect,
      autoApprove: () => true,
      execute,
    });
    const transitions: string[] = [];
    const built = await registry.createModelTools({
      allowToolAutoApproval: false,
      approve: async () => false,
      onResult: () => {},
      onAction: (_request, state) => {
        transitions.push(state);
      },
    });
    const result = await built.tools.inspect!.execute!({}, { toolCallId: 'fixture', messages: [] });
    expect(result).toMatchObject({ status: 'denied' });
    expect(execute).not.toHaveBeenCalled();
    expect(transitions).toEqual(['proposed', 'denied']);
  });

  it('blocks execution if the durable start record fails and records returned execution failures accurately', async () => {
    const execute = vi.fn(async () => ({ status: 'failed', exitCode: 1 }));
    const registry = new ToolRegistry();
    registry.register({
      providerId: 'host',
      name: 'inspect',
      description: 'Fixture inspect',
      inputSchema: { type: 'object', properties: {} },
      effect: action.effect,
      execute,
    });
    const blocked = await registry.createModelTools({
      approve: async () => true,
      onResult: () => {},
      onAction: (_request, state) => {
        if (state === 'started') throw new Error('ledger unavailable');
      },
    });
    expect(await blocked.tools.inspect!.execute!({}, { toolCallId: 'one', messages: [] })).toMatchObject({ status: 'error' });
    expect(execute).not.toHaveBeenCalled();
    const transitions: string[] = [];
    const built = await registry.createModelTools({
      approve: async () => true,
      onResult: () => {},
      onAction: (_request, state) => {
        transitions.push(state);
      },
    });
    await built.tools.inspect!.execute!({}, { toolCallId: 'two', messages: [] });
    expect(transitions).toEqual(['proposed', 'approved', 'started', 'failed']);
  });

  it('returns a paired error result when recording the proposed action fails', async () => {
    const execute = vi.fn(async () => ({ status: 'completed' }));
    const reportResult = vi.fn();
    const registry = new ToolRegistry();
    registry.register({
      providerId: 'host',
      name: 'inspect',
      description: 'Fixture inspect',
      inputSchema: { type: 'object', properties: {} },
      effect: action.effect,
      execute,
    });
    const built = await registry.createModelTools({
      approve: async () => true,
      onResult: reportResult,
      onAction: (_request, state) => {
        if (state === 'proposed') throw new Error('ledger unavailable');
      },
    });

    const result = await built.tools.inspect!.execute!({}, { toolCallId: 'proposal-failed', messages: [] });

    expect(result).toMatchObject({ status: 'error', error: expect.stringContaining('could not be recorded') });
    expect(execute).not.toHaveBeenCalled();
    expect(reportResult).toHaveBeenCalledOnce();
    expect(reportResult).toHaveBeenCalledWith(expect.any(Object), result, 'proposal-failed');
  });
});
