import { describe, expect, it } from 'vitest';
import {
  bindSessionKeyRotation,
  createRotatingModel,
  isAuthError,
  isRetryableError,
  RETRY_DELAYS_MS,
  type V3LanguageModel,
} from '../src/provider/retry.js';

/** A minimal v3 model whose doStream either succeeds or fails with a scripted error. */
function model(script: Array<unknown | { ok: true }>): V3LanguageModel & { calls: number } {
  const state = { calls: 0 };
  const doStream = async () => {
    const step = script[Math.min(state.calls, script.length - 1)];
    state.calls += 1;
    if (step && typeof step === 'object' && 'ok' in step) return { stream: null } as never;
    throw step;
  };
  return {
    specificationVersion: 'v3',
    provider: 'test',
    modelId: 'm',
    supportedUrls: {},
    doGenerate: doStream as never,
    doStream: doStream as never,
    get calls() {
      return state.calls;
    },
  };
}

function apiError(statusCode: number): Error & { statusCode: number } {
  return Object.assign(new Error(`HTTP ${statusCode}`), { statusCode });
}

const noSleep = () => Promise.resolve();

describe('retry classification', () => {
  it('treats 401/403 as an auth failure and not a plain retry', () => {
    expect(isAuthError(apiError(401))).toBe(true);
    expect(isAuthError(apiError(403))).toBe(true);
    expect(isRetryableError(apiError(401))).toBe(false);
  });

  it('retries rate limits, server errors, and transport failures only', () => {
    expect(isRetryableError(apiError(429))).toBe(true);
    expect(isRetryableError(apiError(500))).toBe(true);
    expect(isRetryableError(apiError(503))).toBe(true);
    expect(isRetryableError(new TypeError('fetch failed'))).toBe(true);
    expect(isRetryableError(apiError(400))).toBe(false);
    expect(isRetryableError(apiError(404))).toBe(false);
    expect(isRetryableError(new Error('bad request'))).toBe(false);
  });

  it('honours an explicit isRetryable verdict over the message', () => {
    expect(isRetryableError(Object.assign(new Error('nope'), { isRetryable: false }))).toBe(false);
    expect(isRetryableError(Object.assign(new Error('boom'), { isRetryable: true }))).toBe(true);
  });
});

describe('createRotatingModel', () => {
  it('isolates background metadata key positions and retry notices from the conversation', async () => {
    const notices: unknown[] = [];
    const first = model([apiError(401)]);
    const second = model([{ ok: true }]);
    const shared = createRotatingModel([first, second], { delaysMs: [], poolId: 'fixture', onRetry: (event) => notices.push(event) });
    const conversation = { fixture: 0 };
    const metadata = { ...conversation };
    await (bindSessionKeyRotation(shared, metadata, () => {}) as V3LanguageModel).doGenerate({} as never);
    expect(metadata.fixture).toBe(1);
    expect(conversation.fixture).toBe(0);
    expect(notices).toEqual([]);
  });
  it('keeps the session on B, retries B, and starts a separate session at A', async () => {
    const first = model([apiError(429)]);
    const second = model([{ ok: true }, apiError(429), { ok: true }]);
    const waits: number[] = [];
    const shared = createRotatingModel([first, second], {
      delaysMs: [1, 2],
      sleep: async (ms) => {
        waits.push(ms);
      },
    });
    const positions: Record<string, number> = {};
    const bind = (state: Record<string, number>) => bindSessionKeyRotation(shared, state) as V3LanguageModel;
    await bind(positions).doStream({} as never);
    expect(first.calls).toBe(3);
    expect(second.calls).toBe(1);
    await bind(positions).doGenerate({} as never);
    expect(first.calls).toBe(3);
    expect(second.calls).toBe(3);
    expect(waits).toEqual([1, 2, 1]);
    // Reopening the persisted session must keep B; a new session must try A.
    await bind(JSON.parse(JSON.stringify(positions))).doStream({} as never);
    expect(first.calls).toBe(3);
    await bind({}).doStream({} as never);
    expect(first.calls).toBe(6);
  });

  it('does not wrap to A after every key fails, or rotate after cancellation', async () => {
    const first = model([apiError(429)]);
    const second = model([apiError(429)]);
    const rotating = createRotatingModel([first, second], { delaysMs: [], sleep: noSleep });
    await expect(rotating.doStream({} as never)).rejects.toThrow('HTTP 429');
    await expect(rotating.doStream({} as never)).rejects.toThrow('HTTP 429');
    expect(first.calls).toBe(1);
    expect(second.calls).toBe(2);
    const controller = new AbortController();
    const cancelled = createRotatingModel([first, second], {
      delaysMs: [1],
      sleep: async () => {
        controller.abort();
      },
    });
    await expect(cancelled.doStream({ abortSignal: controller.signal } as never)).rejects.toThrow('Run cancelled');
    expect(first.calls).toBe(2);
    expect(second.calls).toBe(2);
  });

  it('retries the same key through the backoff then succeeds', async () => {
    const waits: number[] = [];
    const first = model([apiError(429), apiError(500), { ok: true }]);
    const rotating = createRotatingModel([first], { sleep: (ms) => (waits.push(ms), noSleep()) });
    await rotating.doStream({} as never);
    expect(first.calls).toBe(3);
    expect(waits).toEqual([RETRY_DELAYS_MS[0], RETRY_DELAYS_MS[1]]);
  });

  it('rotates to the next key when the backoff is exhausted', async () => {
    const waits: number[] = [];
    const rotations: unknown[] = [];
    const first = model([apiError(429)]);
    const second = model([{ ok: true }]);
    const rotating = createRotatingModel([first, second], {
      delaysMs: [1, 2],
      sleep: (ms) => (waits.push(ms), noSleep()),
      onRetry: (event) => event.kind === 'rotate' && rotations.push(event.reason),
    });
    await rotating.doStream({} as never);
    expect(first.calls).toBe(3);
    expect(second.calls).toBe(1);
    expect(waits).toEqual([1, 2]);
    expect(rotations).toEqual(['exhausted']);
  });

  it('rotates immediately on an auth failure without waiting', async () => {
    const waits: number[] = [];
    const first = model([apiError(401)]);
    const second = model([{ ok: true }]);
    const rotating = createRotatingModel([first, second], {
      delaysMs: [1, 2, 3],
      sleep: (ms) => (waits.push(ms), noSleep()),
    });
    await rotating.doStream({} as never);
    expect(first.calls).toBe(1);
    expect(second.calls).toBe(1);
    expect(waits).toEqual([]);
  });

  it('raises a non-retryable error without touching another key', async () => {
    const first = model([apiError(400)]);
    const second = model([{ ok: true }]);
    const rotating = createRotatingModel([first, second], { sleep: noSleep });
    await expect(rotating.doStream({} as never)).rejects.toThrow('HTTP 400');
    expect(first.calls).toBe(1);
    expect(second.calls).toBe(0);
  });

  it('raises the last error once every key is exhausted', async () => {
    const first = model([apiError(500)]);
    const second = model([apiError(500)]);
    const rotating = createRotatingModel([first, second], { delaysMs: [], sleep: noSleep });
    await expect(rotating.doStream({} as never)).rejects.toThrow('HTTP 500');
    expect(first.calls).toBe(1);
    expect(second.calls).toBe(1);
  });

  it('preserves the base provider and model id', () => {
    const rotating = createRotatingModel([model([{ ok: true }])]);
    expect(rotating.specificationVersion).toBe('v3');
    expect(rotating.provider).toBe('test');
    expect(rotating.modelId).toBe('m');
  });
});
