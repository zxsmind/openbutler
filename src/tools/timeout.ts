/** Shared host policy: control metadata never becomes tool/server arguments. */
export const TOOL_TIMEOUT_FIELD = '_timeoutSeconds';
export const DEFAULT_TOOL_TIMEOUT_SECONDS = 60;
export const MAX_TOOL_TIMEOUT_SECONDS = 500;
export const TOOL_TIMEOUT_GUIDANCE = `For every tool call you may set ${TOOL_TIMEOUT_FIELD} to an integer from 1 to ${MAX_TOOL_TIMEOUT_SECONDS} seconds; omission means ${DEFAULT_TOOL_TIMEOUT_SECONDS} seconds. Choose a suitable duration for the work. This host option is not a server argument. Queue and approval waiting do not consume it. A timeout requests cancellation; inspect the target before retrying because external effects may be incomplete.`;

export function toolTimeoutSeconds(value: unknown): number {
  if (value === undefined) return DEFAULT_TOOL_TIMEOUT_SECONDS;
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > MAX_TOOL_TIMEOUT_SECONDS)
    throw new Error(`${TOOL_TIMEOUT_FIELD} must be an integer from 1 to ${MAX_TOOL_TIMEOUT_SECONDS} seconds.`);
  return Number(value);
}

export function withToolTimeoutSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const properties =
    schema.properties && typeof schema.properties === 'object' && !Array.isArray(schema.properties)
      ? (schema.properties as Record<string, unknown>)
      : {};
  if (Object.hasOwn(properties, TOOL_TIMEOUT_FIELD)) throw new Error(`${TOOL_TIMEOUT_FIELD} is reserved for host execution control.`);
  return {
    ...schema,
    properties: { ...properties, [TOOL_TIMEOUT_FIELD]: { type: 'integer', minimum: 1, maximum: MAX_TOOL_TIMEOUT_SECONDS } },
  };
}

export class ToolTimeoutError extends Error {
  constructor(readonly timeoutSeconds: number) {
    super(
      `Tool exceeded ${timeoutSeconds} seconds. Cancellation was requested; inspect the target before retrying because external effects may be incomplete.`,
    );
    this.name = 'ToolTimeoutError';
  }
}

const activeDeadlines = new WeakSet<AbortSignal>();

/** One absolute execution clock. Nested adapters reuse the host signal instead of resetting it. */
export async function runWithToolTimeout<T>(
  seconds: number,
  parent: AbortSignal | undefined,
  execute: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  if (parent && activeDeadlines.has(parent)) return execute(parent);
  if (parent?.aborted) throw parent.reason;
  const controller = new AbortController();
  const forwardAbort = () => controller.abort(parent?.reason);
  parent?.addEventListener('abort', forwardAbort, { once: true });
  let cancellationTimer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: () => void = () => {};
  const cancelled = new Promise<never>((_resolve, reject) => {
    onAbort = () => {
      // Let cooperative handlers finish cancellation and retain partial output in this turn.
      // An adapter that ignores AbortSignal still cannot hold the caller indefinitely.
      cancellationTimer = setTimeout(() => reject(controller.signal.reason), 0);
    };
    controller.signal.addEventListener('abort', onAbort, { once: true });
  });
  const timer = setTimeout(() => controller.abort(new ToolTimeoutError(seconds)), seconds * 1000);
  activeDeadlines.add(controller.signal);
  try {
    const result = await Promise.race([execute(controller.signal), cancelled]);
    if (controller.signal.aborted) {
      const status = result && typeof result === 'object' && 'status' in result ? result.status : undefined;
      if (controller.signal.reason instanceof ToolTimeoutError && status !== 'timed_out') throw controller.signal.reason;
      if (!(controller.signal.reason instanceof ToolTimeoutError) && status !== 'cancelled') throw controller.signal.reason;
    }
    return result;
  } catch (error) {
    if (controller.signal.reason instanceof ToolTimeoutError) throw controller.signal.reason;
    throw error;
  } finally {
    clearTimeout(timer);
    clearTimeout(cancellationTimer);
    controller.signal.removeEventListener('abort', onAbort);
    parent?.removeEventListener('abort', forwardAbort);
    activeDeadlines.delete(controller.signal);
  }
}
