import type { LanguageModelV3CallOptions } from '@ai-sdk/provider';
import type { ModelMessage } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import { describe, expect, it } from 'vitest';
import { autoReviewFingerprint, reviewToolRequest, type AutoReviewResult } from '../src/auto-review.js';
import type { ToolCallRequest } from '../src/tools/registry.js';

/**
 * Direct tests for the reviewer itself.
 *
 * `auto-review.test.ts` exercises the session wiring with a stubbed reviewer; it never
 * runs the real policy, preparation, or validation. That leaves the highest-risk code in
 * the permission path — the code that turns untrusted tool data into an allow/deny/escalate
 * decision — covered only by inspection. These tests call `reviewToolRequest` for real with
 * a mock model so redaction, truncation, timeout, abort, and the verdict invariants are
 * pinned by assertions instead of trust.
 */

const usage = {
  inputTokens: { total: 40, noCache: 40, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 12, text: 12, reasoning: 0 },
};

function decisionModel(json: string): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doGenerate: async () => ({
      content: [{ type: 'text' as const, text: json }],
      finishReason: { unified: 'stop' as const, raw: 'stop' as const },
      usage,
      warnings: [],
    }),
    doStream: async () => ({
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue({ type: 'stream-start', warnings: [] });
          controller.enqueue({
            type: 'tool-call',
            toolCallId: 'review-1',
            toolName: 'auto_review_decision',
            input: json,
          });
          controller.enqueue({
            type: 'finish',
            finishReason: { unified: 'stop' as const, raw: 'stop' as const },
            usage,
          });
          controller.close();
        },
      }),
    }),
  });
}

function validDecision(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    authority: 'explicit',
    verdict: 'allow',
    confidence: 'high',
    risk: 'low',
    reason: 'Within the stated request.',
    ...overrides,
  });
}

/** A model that never answers on its own; it only settles when the caller aborts. */
function hangingModel(): MockLanguageModelV3 {
  const hang = ({ abortSignal }: LanguageModelV3CallOptions) =>
    new Promise<never>((_resolve, reject) => {
      if (abortSignal?.aborted) return reject(new Error('aborted'));
      abortSignal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    });
  return new MockLanguageModelV3({
    doGenerate: hang,
    doStream: async ({ abortSignal }: LanguageModelV3CallOptions) => ({
      stream: new ReadableStream({
        start(controller) {
          if (abortSignal?.aborted) {
            controller.error(new Error('aborted'));
            return;
          }
          controller.enqueue({ type: 'stream-start', warnings: [] });
          abortSignal?.addEventListener(
            'abort',
            () => {
              try {
                controller.error(new Error('aborted'));
              } catch {
                // The stream already settled; the abort still rejects the call.
              }
            },
            { once: true },
          );
        },
      }),
    }),
  });
}

function throwingModel(): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doGenerate: async () => {
      throw new Error('provider exploded');
    },
    doStream: async () => {
      throw new Error('provider exploded');
    },
  });
}

function request(overrides: Partial<ToolCallRequest> = {}): ToolCallRequest {
  return {
    requestId: 'req-1',
    providerId: 'host',
    name: 'execute_command',
    input: { command: 'rm -rf ./build' },
    effect: { change: 'delete', data: 'local', network: 'none', reversible: 'none', outbound: 'model' },
    ...overrides,
  };
}

const userTurn = [{ role: 'user', content: 'Delete the generated build output.' }] as unknown as ModelMessage[];

async function review(options: {
  model: MockLanguageModelV3;
  request?: ToolCallRequest;
  messages?: ModelMessage[];
  timeoutMs?: number;
  signal?: AbortSignal;
  authorizedSchedule?: { kind: 'schedule'; name: string; instruction: string; triggerFacts: unknown };
}): Promise<AutoReviewResult> {
  return reviewToolRequest({
    model: options.model,
    request: options.request ?? request(),
    messages: options.messages ?? userTurn,
    workspaceRoot: process.cwd(),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.authorizedSchedule === undefined ? {} : { authorizedSchedule: options.authorizedSchedule }),
  });
}

describe('reviewToolRequest decisions', () => {
  it('passes a well-formed, conservative decision straight through', async () => {
    const result = await review({ model: decisionModel(validDecision()) });
    expect(result).toEqual({
      status: 'decision',
      decision: { verdict: 'allow', confidence: 'high', risk: 'low', authority: 'explicit', reason: 'Within the stated request.' },
    });
  });

  it('coerces an allow below high confidence to escalate', async () => {
    const result = await review({ model: decisionModel(validDecision({ confidence: 'medium' })) });
    expect(result.status).toBe('decision');
    expect(result.status === 'decision' && result.decision.verdict).toBe('escalate');
  });

  it('coerces an allow at high or critical risk to escalate', async () => {
    for (const risk of ['high', 'critical', 'unknown']) {
      const result = await review({ model: decisionModel(validDecision({ risk })) });
      expect(result.status === 'decision' && result.decision.verdict).toBe('escalate');
    }
  });

  it('coerces a low-confidence deny to escalate instead of denying on weak evidence', async () => {
    const result = await review({ model: decisionModel(validDecision({ verdict: 'deny', confidence: 'low', risk: 'low' })) });
    expect(result.status === 'decision' && result.decision.verdict).toBe('escalate');
  });

  it('keeps a high-confidence deny', async () => {
    const result = await review({ model: decisionModel(validDecision({ verdict: 'deny', confidence: 'high', risk: 'moderate' })) });
    expect(result.status === 'decision' && result.decision.verdict).toBe('deny');
  });

  it('rejects a schema-valid verdict whose reason is blank', async () => {
    const result = await review({ model: decisionModel(validDecision({ reason: '   ' })) });
    expect(result).toMatchObject({ status: 'unavailable', code: 'invalid-output' });
  });
});

describe('reviewToolRequest preparation and failure handling', () => {
  it('refuses to review input that contains a credential field', async () => {
    const result = await review({
      model: decisionModel(validDecision()),
      request: request({ input: { command: 'curl', apiKey: 'placeholder-value' } }),
    });
    expect(result).toMatchObject({ status: 'unavailable', code: 'sensitive-input' });
  });

  it('refuses to review input too large to see completely', async () => {
    const result = await review({
      model: decisionModel(validDecision()),
      request: request({ input: { blob: 'x'.repeat(9_000) } }),
    });
    expect(result).toMatchObject({ status: 'unavailable', code: 'oversized-input' });
  });

  it('refuses when there is no user instruction to compare against', async () => {
    const result = await review({
      model: decisionModel(validDecision()),
      messages: [{ role: 'assistant', content: 'All done.' }] as unknown as ModelMessage[],
    });
    expect(result).toMatchObject({ status: 'unavailable', code: 'no-instruction' });
  });

  it('times out on a slow model and reports it as a timeout, not a denial', async () => {
    const result = await review({ model: hangingModel(), timeoutMs: 40 });
    expect(result).toMatchObject({ status: 'unavailable', code: 'timeout' });
    expect(result.status === 'unavailable' && result.reason).toContain('timed out');
  });

  it('does not time out while the reviewer keeps streaming, even past the idle budget', async () => {
    const json = validDecision();
    const chunks = 6;
    const model = new MockLanguageModelV3({
      doStream: async ({ abortSignal }: LanguageModelV3CallOptions) => ({
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: 'stream-start', warnings: [] });
            controller.enqueue({ type: 'text-start', id: 'thinking' });
            let index = 0;
            const timer = setInterval(() => {
              if (abortSignal?.aborted) {
                clearInterval(timer);
                try {
                  controller.error(new Error('aborted'));
                } catch {
                  // Already settled.
                }
                return;
              }
              index++;
              if (index <= chunks) {
                controller.enqueue({ type: 'text-delta', id: 'thinking', delta: 'still considering. ' });
              } else {
                clearInterval(timer);
                controller.enqueue({ type: 'text-end', id: 'thinking' });
                controller.enqueue({
                  type: 'tool-call',
                  toolCallId: 'review-1',
                  toolName: 'auto_review_decision',
                  input: json,
                });
                controller.enqueue({
                  type: 'finish',
                  finishReason: { unified: 'stop' as const, raw: 'stop' as const },
                  usage,
                });
                controller.close();
              }
            }, 20);
          },
        }),
      }),
    });
    // Six progress ticks at 20ms intervals take ~120ms wall time, well past
    // the 40ms idle budget. An absolute deadline would kill this review;
    // steady progress must keep it alive.
    const result = await review({ model, timeoutMs: 40 });
    expect(result).toEqual({
      status: 'decision',
      decision: { verdict: 'allow', confidence: 'high', risk: 'low', authority: 'explicit', reason: 'Within the stated request.' },
    });
  });

  it('reports a model failure as model-error rather than a decision', async () => {
    const result = await review({ model: throwingModel() });
    expect(result).toMatchObject({ status: 'unavailable', code: 'model-error' });
  });

  it('returns cancelled when the run is aborted before the call', async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await review({ model: decisionModel(validDecision()), signal: controller.signal });
    expect(result).toEqual({ status: 'cancelled' });
  });

  it('returns cancelled when the run is aborted mid-review', async () => {
    const controller = new AbortController();
    const pending = review({ model: hangingModel(), signal: controller.signal, timeoutMs: 10_000 });
    controller.abort();
    expect(await pending).toEqual({ status: 'cancelled' });
  });
});

describe('reviewToolRequest schedule authority', () => {
  it('reviews against a configured task instruction when it is clean', async () => {
    const result = await review({
      model: decisionModel(validDecision()),
      authorizedSchedule: {
        kind: 'schedule',
        name: 'Nightly cleanup',
        instruction: 'Remove stale build output.',
        triggerFacts: {},
      },
    });
    expect(result.status).toBe('decision');
  });

  it('refuses a configured task instruction that carries a credential', async () => {
    const result = await review({
      model: decisionModel(validDecision()),
      authorizedSchedule: {
        kind: 'schedule',
        name: 'Leaky task',
        instruction: `token=ghp_${'a'.repeat(36)}`,
        triggerFacts: {},
      },
    });
    expect(result).toMatchObject({ status: 'unavailable', code: 'sensitive-schedule-instruction' });
  });

  it('refuses trigger facts too large to review completely', async () => {
    const result = await review({
      model: decisionModel(validDecision()),
      authorizedSchedule: {
        kind: 'schedule',
        name: 'Nightly cleanup',
        instruction: 'Remove stale build output.',
        triggerFacts: { payload: 'x'.repeat(9_000) },
      },
    });
    expect(result).toMatchObject({ status: 'unavailable', code: 'oversized-trigger-facts' });
  });
});

describe('autoReviewFingerprint', () => {
  it('is stable across input key order so a reworded retry cannot slip past a prior denial', () => {
    const a = request({ input: { command: 'rm -rf ./build', cwd: '/tmp' } });
    const b = request({ input: { cwd: '/tmp', command: 'rm -rf ./build' } });
    expect(autoReviewFingerprint(a)).toBe(autoReviewFingerprint(b));
  });

  it('changes when the exact action changes', () => {
    expect(autoReviewFingerprint(request())).not.toBe(autoReviewFingerprint(request({ input: { command: 'rm -rf ./dist' } })));
  });
});
