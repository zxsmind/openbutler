import type { LanguageModel } from 'ai';

/**
 * A language model that is definitely v3, the AI SDK's provider interface.
 *
 * `LanguageModel` is a union that also admits a bare provider/model id string,
 * so narrowing to the object shape keeps the delegate calls type-safe without
 * importing the provider package directly.
 */
export type V3LanguageModel = Extract<LanguageModel, { specificationVersion: 'v3' }>;
type StreamOptions = Parameters<V3LanguageModel['doStream']>[0];
type StreamResult = Awaited<ReturnType<V3LanguageModel['doStream']>>;
type GenerateResult = Awaited<ReturnType<V3LanguageModel['doGenerate']>>;

/**
 * The backoff OpenButler applies to one key before moving to the next.
 *
 * 1s, 2s, 4s, 8s, 16s, 32s, 32s, 32s, 64s: nine waits, so up to ten attempts on a key. When
 * the sequence is exhausted the request moves to the next configured key; when
 * every key is exhausted the last error is raised. Retry lives here, not in the
 * AI SDK, so the two never compound.
 */
export const RETRY_DELAYS_MS: readonly number[] = [1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 32_000, 32_000, 64_000];

export type RetryEvent =
  | { kind: 'retry'; keyIndex: number; attempt: number; waitMs: number; error: unknown }
  | { kind: 'rotate'; keyIndex: number; reason: 'auth' | 'exhausted'; error: unknown };

export interface RotatingModelOptions {
  /** Opaque identity of the configured provider/key list. */
  poolId?: string;
  /** Owned and persisted by the conversation, never by the shared runtime. */
  keyPositions?: Record<string, number>;
  /** Override the backoff sequence; tests pass `[]` to retry without waiting. */
  delaysMs?: readonly number[];
  /** Override the wait; tests record the requested delays instead of sleeping. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Observes each retry and rotation. */
  onRetry?: (event: RetryEvent) => void;
}

const sessionBindings = new WeakMap<
  object,
  (positions: Record<string, number>, onRetry?: (event: RetryEvent) => void) => V3LanguageModel
>();

export function bindSessionKeyRotation(
  model: LanguageModel,
  positions: Record<string, number>,
  onRetry?: (event: RetryEvent) => void,
): LanguageModel {
  return typeof model === 'string' ? model : (sessionBindings.get(model)?.(positions, onRetry) ?? model);
}

function statusOf(error: unknown): number | undefined {
  const status = error !== null && typeof error === 'object' ? (error as { statusCode?: unknown }).statusCode : undefined;
  return typeof status === 'number' ? status : undefined;
}

/** A rejected credential: the request will never succeed on this key. */
export function isAuthError(error: unknown): boolean {
  const status = statusOf(error);
  return status === 401 || status === 403;
}

/**
 * A failure another attempt, or another key, may survive.
 *
 * A transport failure carries no status; a rejected request carries one, and
 * only 408/409/429 and 5xx are worth repeating. Everything else (a malformed
 * request, a missing model) is the same on every key, so it is raised at once.
 */
export function isRetryableError(error: unknown): boolean {
  const status = statusOf(error);
  if (status !== undefined) return status === 408 || status === 409 || status === 429 || status >= 500;
  if (error !== null && typeof error === 'object') {
    const flag = (error as { isRetryable?: unknown }).isRetryable;
    if (flag === false) return false;
    if (flag === true) return true;
  }
  return (
    error instanceof TypeError ||
    (error instanceof Error && /fetch failed|network|socket|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN/i.test(error.message))
  );
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('Run cancelled.'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    (timer as { unref?: () => void }).unref?.();
  });
}

/**
 * Wraps one model per key behind a single model that retries and rotates.
 *
 * Each call starts at the session's current key; a retryable failure waits through the
 * backoff and tries again, and once the sequence is exhausted (or a key is
 * rejected outright) the call moves to the next key. With a single key this is
 * a plain retry; the identity of the base model is preserved so the SDK still
 * reports the right provider and model id.
 */
export function createRotatingModel(models: readonly V3LanguageModel[], options: RotatingModelOptions = {}): V3LanguageModel {
  const base = models[0];
  if (!base) throw new Error('createRotatingModel needs at least one model.');
  const delays = options.delaysMs ?? RETRY_DELAYS_MS;
  const sleep = options.sleep ?? defaultSleep;
  const positions = options.keyPositions ?? {};
  const poolId = options.poolId ?? 'default';

  const run = async <T>(signal: AbortSignal | undefined, call: (model: V3LanguageModel) => PromiseLike<T>): Promise<T> => {
    const start = positions[poolId] ?? 0;
    if (!Number.isSafeInteger(start) || start < 0 || start >= models.length) {
      throw new Error('Saved key position is outside the configured key pool.');
    }
    let lastError: unknown;
    for (let keyIndex = start; keyIndex < models.length; keyIndex++) {
      if (signal?.aborted) throw new Error('Run cancelled.');
      keyIndex = Math.max(keyIndex, positions[poolId] ?? 0);
      positions[poolId] = keyIndex;
      const model = models[keyIndex]!;
      const hasNextKey = keyIndex < models.length - 1;
      for (let attempt = 0; ; attempt++) {
        if (signal?.aborted) throw new Error('Run cancelled.');
        try {
          return await call(model);
        } catch (error) {
          if (signal?.aborted) throw error;
          lastError = error;
          if (isAuthError(error)) {
            if (hasNextKey) {
              positions[poolId] = Math.max(keyIndex + 1, positions[poolId] ?? 0);
              options.onRetry?.({ kind: 'rotate', keyIndex, reason: 'auth', error });
              break;
            }
            throw error;
          }
          if (!isRetryableError(error)) throw error;
          if (attempt < delays.length) {
            const waitMs = delays[attempt]!;
            options.onRetry?.({ kind: 'retry', keyIndex, attempt, waitMs, error });
            await sleep(waitMs, signal);
            continue;
          }
          if (hasNextKey) {
            positions[poolId] = Math.max(keyIndex + 1, positions[poolId] ?? 0);
            options.onRetry?.({ kind: 'rotate', keyIndex, reason: 'exhausted', error });
            break;
          }
          throw error;
        }
      }
    }
    throw lastError;
  };

  const rotating: V3LanguageModel = {
    specificationVersion: 'v3',
    provider: base.provider,
    modelId: base.modelId,
    supportedUrls: base.supportedUrls,
    doGenerate: (callOptions) => run(callOptions.abortSignal, (model) => model.doGenerate(callOptions)) as PromiseLike<GenerateResult>,
    doStream: (callOptions: StreamOptions) =>
      run(callOptions.abortSignal, (model) => model.doStream(callOptions)) as PromiseLike<StreamResult>,
  };
  sessionBindings.set(rotating, (keyPositions, onRetry) =>
    createRotatingModel(models, { ...options, keyPositions, ...(onRetry ? { onRetry } : {}) }),
  );
  return rotating;
}
