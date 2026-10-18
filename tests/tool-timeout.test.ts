import { afterEach, describe, expect, it, vi } from 'vitest';
import { ToolRegistry, type ToolDefinition } from '../src/tools/registry.js';
import { DEFAULT_TOOL_TIMEOUT_SECONDS, runWithToolTimeout, TOOL_TIMEOUT_FIELD, TOOL_TIMEOUT_GUIDANCE } from '../src/tools/timeout.js';

const effect = { change: 'none', data: 'local', network: 'none', reversible: 'full', outbound: 'model' } as const;
const execOptions = { toolCallId: 'timed-call', messages: [] };
const definition = (execute: ToolDefinition['execute'], providerId = 'host'): ToolDefinition => ({
  providerId,
  name: 'wait',
  description: 'Fixture operation.',
  inputSchema: { type: 'object', properties: { value: { type: 'string' } }, additionalProperties: false },
  effect,
  execute,
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
afterEach(() => vi.useRealTimers());

describe('one host-owned tool timeout contract', () => {
  it.each(['host', 'mcp-fixture'])('adds one minimal schema field to %s and consumes it before calling the tool', async (providerId) => {
    const execute = vi.fn(async (input, _signal, context) => ({ input, seconds: context?.timeoutSeconds }));
    const tool = definition(execute, providerId);
    const originalSchema = JSON.stringify(tool.inputSchema);
    const registry = new ToolRegistry();
    registry.register(tool);
    const built = await registry.createModelTools({ approve: async () => true, onResult: () => {} });
    const available = Object.values(built.tools)[0]!;
    const schema = available.inputSchema as unknown as { jsonSchema: Record<string, unknown> };
    expect(schema.jsonSchema).toMatchObject({ properties: { [TOOL_TIMEOUT_FIELD]: { type: 'integer', minimum: 1, maximum: 500 } } });
    expect(JSON.stringify(schema.jsonSchema)).not.toContain('description');
    expect(JSON.stringify(tool.inputSchema)).toBe(originalSchema);
    expect(await available.execute!({ value: 'hello', _timeoutSeconds: 200 }, execOptions)).toEqual({
      input: { value: 'hello' },
      seconds: 200,
    });
    expect(await available.execute!({ value: 'default' }, execOptions)).toMatchObject({ seconds: DEFAULT_TOOL_TIMEOUT_SECONDS });
    expect(TOOL_TIMEOUT_GUIDANCE).toContain('60 seconds');
    expect(TOOL_TIMEOUT_GUIDANCE).toContain('500 seconds');
  });

  it.each([0, 501, 1.5, '200', null])('rejects invalid duration %j before approval or execution', async (value) => {
    const execute = vi.fn(async () => ({}));
    const approve = vi.fn(async () => true);
    const registry = new ToolRegistry();
    registry.register(definition(execute));
    const built = await registry.createModelTools({ approve, onResult: () => {} });
    expect(await built.tools.wait!.execute!({ _timeoutSeconds: value }, execOptions)).toMatchObject({ status: 'invalid' });
    expect(approve).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it('allows 500 seconds without the old 60-second cutoff and cleans the timer on success', async () => {
    vi.useFakeTimers();
    const entered = deferred<AbortSignal>();
    const finish = deferred<unknown>();
    const registry = new ToolRegistry();
    registry.register(
      definition(async (_input, signal) => {
        entered.resolve(signal!);
        return finish.promise;
      }),
    );
    const built = await registry.createModelTools({ approve: async () => true, onResult: () => {} });
    const running = built.tools.wait!.execute!({ _timeoutSeconds: 500 }, execOptions);
    const signal = await entered.promise;
    await vi.advanceTimersByTimeAsync(61_000);
    expect(signal.aborted).toBe(false);
    finish.resolve({ status: 'completed' });
    expect(await running).toEqual({ status: 'completed' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([undefined, 1, 500])(
    'expires at the effective budget %s even for a non-cooperative tool; late results never publish',
    async (seconds) => {
      vi.useFakeTimers();
      const entered = deferred<AbortSignal>();
      const finish = deferred<unknown>();
      const onResult = vi.fn();
      const states: string[] = [];
      const registry = new ToolRegistry();
      registry.register(
        definition(async (_input, signal) => {
          entered.resolve(signal!);
          return finish.promise;
        }),
      );
      const built = await registry.createModelTools({
        approve: async () => true,
        onResult,
        onAction: async (_request, state) => {
          states.push(state);
        },
      });
      const running = built.tools.wait!.execute!(seconds === undefined ? {} : { _timeoutSeconds: seconds }, execOptions);
      const signal = await entered.promise;
      const duration = seconds ?? 60;
      await vi.advanceTimersByTimeAsync(duration * 1000 - 1);
      expect(signal.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(2);
      expect(await running).toMatchObject({ status: 'timed_out', timeoutSeconds: duration });
      expect(signal.aborted).toBe(true);
      expect(states).toEqual(['proposed', 'approved', 'started', 'failed']);
      finish.resolve({ status: 'completed' });
      await Promise.resolve();
      expect(onResult).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it('starts the execution clock only after approval waiting ends', async () => {
    vi.useFakeTimers();
    const approval = deferred<boolean>();
    const asked = deferred<void>();
    const entered = deferred<void>();
    const registry = new ToolRegistry();
    registry.register(
      definition(async () => {
        entered.resolve();
        return new Promise(() => {});
      }),
    );
    const built = await registry.createModelTools({
      approve: async () => {
        asked.resolve();
        return approval.promise;
      },
      onResult: () => {},
    });
    const running = built.tools.wait!.execute!({ _timeoutSeconds: 1 }, execOptions);
    await asked.promise;
    await vi.advanceTimersByTimeAsync(100_000);
    expect(vi.getTimerCount()).toBe(0);
    approval.resolve(true);
    await entered.promise;
    await vi.advanceTimersByTimeAsync(1001);
    expect(await running).toMatchObject({ status: 'timed_out', timeoutSeconds: 1 });
  });

  it('does not charge time spent behind another queued tool call', async () => {
    vi.useFakeTimers();
    const firstStarted = deferred<void>();
    const secondStarted = deferred<AbortSignal>();
    const finish = deferred<unknown>();
    const registry = new ToolRegistry();
    registry.register(
      definition(async (input, signal) => {
        if (input.value === 'first') {
          firstStarted.resolve();
          return finish.promise;
        }
        secondStarted.resolve(signal!);
        return new Promise(() => {});
      }),
    );
    const built = await registry.createModelTools({ approve: async () => true, onResult: () => {} });
    const first = built.tools.wait!.execute!({ value: 'first', _timeoutSeconds: 500 }, execOptions);
    const second = built.tools.wait!.execute!({ value: 'second', _timeoutSeconds: 1 }, execOptions);
    await firstStarted.promise;
    await vi.advanceTimersByTimeAsync(61_000);
    finish.resolve({ status: 'completed' });
    await first;
    const signal = await secondStarted.promise;
    await vi.advanceTimersByTimeAsync(999);
    expect(signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    expect(await second).toMatchObject({ status: 'timed_out', timeoutSeconds: 1 });
  });

  it('reserves only the host control name and leaves a server timeout argument intact', async () => {
    const registry = new ToolRegistry();
    const tool = definition(async (input) => input);
    tool.inputSchema = { type: 'object', properties: { timeoutSeconds: { type: 'number' } } };
    registry.register(tool);
    const built = await registry.createModelTools({ approve: async () => true, onResult: () => {} });
    expect(await built.tools.wait!.execute!({ timeoutSeconds: 12, _timeoutSeconds: 200 }, execOptions)).toEqual({ timeoutSeconds: 12 });
    const collision = definition(async () => ({}), 'mcp-reserved');
    collision.inputSchema = { type: 'object', properties: { _timeoutSeconds: { type: 'string' } } };
    expect(() => registry.register(collision)).toThrow('reserved');
  });

  it('keeps owner cancellation distinct from expiration and removes deadline timers', async () => {
    vi.useFakeTimers();
    const parent = new AbortController();
    const entered = deferred<void>();
    const registry = new ToolRegistry();
    registry.register(
      definition(async () => {
        entered.resolve();
        return new Promise(() => {});
      }),
    );
    const built = await registry.createModelTools({ approve: async () => true, onResult: () => {}, signal: parent.signal });
    const running = built.tools.wait!.execute!({ _timeoutSeconds: 500 }, execOptions);
    await entered.promise;
    parent.abort();
    await vi.advanceTimersByTimeAsync(1);
    expect(await running).toMatchObject({ status: 'cancelled' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('nested adapters reuse the host deadline instead of installing a shorter private timer', async () => {
    vi.useFakeTimers();
    const finish = deferred<string>();
    let observed: AbortSignal | undefined;
    const running = runWithToolTimeout(500, undefined, async (parent) =>
      runWithToolTimeout(60, parent, async (child) => {
        expect(child).toBe(parent);
        observed = child;
        return finish.promise;
      }),
    );
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(61_000);
    expect(observed?.aborted).toBe(false);
    finish.resolve('done');
    expect(await running).toBe('done');
    expect(vi.getTimerCount()).toBe(0);
  });
});
