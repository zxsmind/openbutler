import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { MockLanguageModelV3 } from 'ai/test';
import type { LanguageModelV3StreamPart } from '@ai-sdk/provider';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { ActivityLedger } from '../src/activity-ledger.js';
import type { AgentEnvironment, AgentSessionController } from '../src/agent-session.js';
import type { AutoReviewDecision, AutoReviewResult } from '../src/auto-review.js';
import { ToolRegistry, type ToolExecutionContext } from '../src/tools/registry.js';

const usage = {
  inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 20, text: 20, reasoning: 0 },
};
const preferences = { reasoningVariantId: 'default', showReasoning: false };

function stream(parts: LanguageModelV3StreamPart[], reason: 'stop' | 'tool-calls' = 'stop') {
  return {
    stream: new ReadableStream({
      start(controller) {
        controller.enqueue({ type: 'stream-start', warnings: [] });
        for (const part of parts) controller.enqueue(part);
        controller.enqueue({ type: 'finish', finishReason: { unified: reason, raw: reason }, usage });
        controller.close();
      },
    }),
  };
}
function textStream(text: string) {
  return stream([
    { type: 'text-start', id: 'answer' },
    { type: 'text-delta', id: 'answer', delta: text },
    { type: 'text-end', id: 'answer' },
  ]);
}
function toolCallStream(toolName: string, callId: string) {
  return stream([{ type: 'tool-call', toolCallId: callId, toolName, input: '{}' }], 'tool-calls');
}
function titleResponse() {
  return {
    content: [{ type: 'text' as const, text: '{"title":"Auto-review fixture"}' }],
    finishReason: { unified: 'stop' as const, raw: 'stop' as const },
    usage,
    warnings: [],
  };
}

function verdict(overrides: Partial<AutoReviewDecision> = {}): AutoReviewResult {
  return {
    status: 'decision',
    decision: { verdict: 'allow', confidence: 'high', risk: 'moderate', reason: 'Within the stated request.', ...overrides },
  };
}

let root: string;
let previousDataDir: string | undefined;
let ledger: ActivityLedger;
let model: MockLanguageModelV3;
let registry: ToolRegistry;
let execute: Mock<(input: Record<string, unknown>, signal?: AbortSignal, context?: ToolExecutionContext) => Promise<unknown>>;
let controller: AgentSessionController | undefined;

beforeEach(() => {
  previousDataDir = process.env.RANITE_DATA_DIR;
  root = mkdtempSync(join(tmpdir(), 'ranite-auto-review-'));
  process.env.RANITE_DATA_DIR = root;
  vi.resetModules();
  ledger = new ActivityLedger(join(root, 'state.db'));
  execute = vi.fn<(input: Record<string, unknown>, signal?: AbortSignal, context?: ToolExecutionContext) => Promise<unknown>>(async () => ({
    status: 'completed',
    detail: 'fixture result',
  }));
  registry = new ToolRegistry();
  registry.register({
    providerId: 'host',
    name: 'inspect',
    description: 'Fixture tool that always reaches the reviewer',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    effect: { change: 'none', data: 'local', network: 'none', reversible: 'full', outbound: 'model' },
    execute,
  });
  model = new MockLanguageModelV3({
    doGenerate: async () => titleResponse(),
    doStream: vi
      .fn()
      .mockImplementationOnce(async () => toolCallStream('inspect', 'call-1'))
      .mockImplementation(async () => textStream('Auto-review fixture complete')),
  });
});

afterEach(async () => {
  await controller?.close();
  controller = undefined;
  ledger.close();
  if (previousDataDir === undefined) delete process.env.RANITE_DATA_DIR;
  else process.env.RANITE_DATA_DIR = previousDataDir;
  if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith('ranite-auto-review-')) {
    throw new Error('Refusing to remove a directory outside this test fixture.');
  }
  rmSync(root, { recursive: true, force: true });
});

function runtime(): AgentEnvironment {
  return {
    model,
    workspaceRoot: process.cwd(),
    modelName: 'Reviewer fixture',
    providerId: 'fixture',
    modelId: 'fixture',
    contextWindowTokens: null,
    outputLimitTokens: null,
    supportsVision: false,
    supportsImageToolResult: true,
    reasoningVariants: [],
    reasoningMetadataSource: null,
    reasoningSupport: 'model-unsupported',
    reasoningDefault: 'default',
    saveReasoningPreference: () => {},
    showReasoningDefault: false,
    saveShowReasoningPreference: () => {},
    approvalMode: 'auto-review',
    getReasoningProviderOptions: () => ({}),
    getReviewProviderOptions: () => ({}),
    registry,
    selectModel: async () => {},
    close: async () => {},
  };
}

/** Wires the real controller to the real ledger, which is the pair that regressed. */
async function startSession(autoReviewer: (options: { request: { requestId: string } }) => Promise<AutoReviewResult>) {
  const { AgentSessionController } = await import('../src/agent-session.js');
  controller = new AgentSessionController(runtime(), (action) => ledger.recordToolAction(action), { autoReviewer: autoReviewer as never });
  return controller;
}

describe('auto-review history summary', () => {
  const effect = { change: 'none', data: 'local', network: 'none', reversible: 'full', outbound: 'model' } as const;

  function record(requestId: string, state: 'proposed' | 'reviewed' | 'review_unavailable', result?: unknown) {
    ledger.recordToolAction({
      requestId,
      workspaceRoot: process.cwd(),
      sessionId: 'summary-session',
      providerId: 'host',
      name: 'inspect',
      input: {},
      effect,
      state,
      ...(result === undefined ? {} : { result }),
    });
  }

  it('counts decisions and breaks unavailable reviews down by their code', () => {
    record('a', 'proposed');
    record('a', 'reviewed', { verdict: 'allow' });
    record('b', 'proposed');
    record('b', 'reviewed', { verdict: 'deny' });
    record('c', 'proposed');
    record('c', 'reviewed', { verdict: 'escalate' });
    record('d', 'proposed');
    record('d', 'review_unavailable', { code: 'timeout', reason: 'slow' });
    record('e', 'proposed');
    record('e', 'review_unavailable', { code: 'timeout', reason: 'slow again' });

    expect(ledger.autoReviewSummary()).toEqual({
      reviewed: 3,
      allow: 1,
      deny: 1,
      escalate: 1,
      unavailable: 2,
      unavailableByCode: { timeout: 2 },
    });
  });

  it('reports an empty summary before any review has run', () => {
    expect(ledger.autoReviewSummary()).toEqual({
      reviewed: 0,
      allow: 0,
      deny: 0,
      escalate: 0,
      unavailable: 0,
      unavailableByCode: {},
    });
  });
});

describe('auto-review records its verdict and still lets the decision through', () => {
  it('keeps the selected reasoning settings for agent, reviewer, and title requests', async () => {
    const providerOptions = { fixture: { reasoningEffort: 'xhigh', cache_salt: 'conversation-cache' } };
    const reviewVerdict = JSON.stringify({
      verdict: 'allow',
      confidence: 'high',
      risk: 'low',
      reason: 'The user requested this inspection.',
      authority: 'explicit',
    });
    model = new MockLanguageModelV3({
      doGenerate: [titleResponse()],
      doStream: [
        toolCallStream('inspect', 'call-1'),
        {
          stream: new ReadableStream({
            start(controller) {
              controller.enqueue({ type: 'stream-start', warnings: [] });
              controller.enqueue({
                type: 'tool-call',
                toolCallId: 'review-1',
                toolName: 'auto_review_decision',
                input: reviewVerdict,
              });
              controller.enqueue({ type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage });
              controller.close();
            },
          }),
        },
        textStream('Auto-review fixture complete'),
      ],
    });
    const environment = runtime();
    environment.getReasoningProviderOptions = () => providerOptions;
    const { AgentSessionController } = await import('../src/agent-session.js');
    controller = new AgentSessionController(environment, (action) => ledger.recordToolAction(action));
    await controller.sendMessage({ text: 'Inspect the fixture', images: [] }, { reasoningVariantId: 'xhigh', showReasoning: false });
    expect(execute).toHaveBeenCalledOnce();
    // The title is metadata: the run hands it to a background task instead of
    // waiting for it, so the request lands after sendMessage resolves.
    await vi.waitFor(() => expect(model.doGenerateCalls).toHaveLength(1));
    expect(model.doGenerateCalls[0]!.providerOptions).toEqual(providerOptions);
    expect(model.doStreamCalls).toHaveLength(3);
    // The review streams without the turn's reasoning effort; agent steps keep it.
    const reviewCalls = model.doStreamCalls.filter((call) => Object.keys(call.providerOptions ?? {}).length === 0);
    expect(reviewCalls).toHaveLength(1);
    for (const request of model.doStreamCalls.filter((call) => call !== reviewCalls[0])) {
      expect(request.providerOptions).toEqual(providerOptions);
    }
    for (const request of model.doGenerateCalls) expect(request.maxOutputTokens).toBeUndefined();
    const [row] = ledger.listActions();
    const reviewed = ledger.actionTransitions(row!.requestId).find((entry) => entry.state === 'reviewed');
    expect(reviewed?.detail).toMatchObject({ verdict: 'allow', authority: 'explicit' });
  });

  it('reviews an identical side-effect-free action once per turn and stays quiet on allow', async () => {
    const reviewer = vi.fn(async () => verdict());
    const session = await startSession(reviewer as never);
    model.doStream = vi
      .fn()
      .mockImplementationOnce(async () => toolCallStream('inspect', 'call-1'))
      .mockImplementationOnce(async () => toolCallStream('inspect', 'call-2'))
      .mockImplementation(async () => textStream('Auto-review fixture complete'));
    await session.sendMessage({ text: 'Inspect the fixture twice', images: [] }, preferences);

    expect(execute).toHaveBeenCalledTimes(2);
    expect(reviewer).toHaveBeenCalledOnce();
    const reviewed = ledger
      .listActions()
      .flatMap((row) => ledger.actionTransitions(row.requestId))
      .filter((entry) => entry.state === 'reviewed');
    expect(reviewed).toHaveLength(2);
    expect(reviewed.filter((entry) => (entry.detail as { repeated?: boolean })?.repeated === true)).toHaveLength(1);
    const notices = session.getSnapshot().session.entries.filter((entry) => entry.kind === 'notice');
    expect(notices.some((entry) => entry.kind === 'notice' && entry.text.includes('Auto-review approved'))).toBe(false);
  });

  it('retries a denied action once after user approval, with the override visible to the reviewer', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const reviewer = vi.fn(async (options: Record<string, unknown>) => {
      seen.push(options);
      return seen.length === 1 ? verdict({ verdict: 'deny', risk: 'high', reason: 'Outside the request.' }) : verdict();
    });
    const session = await startSession(reviewer as never);
    model.doStream = vi
      .fn()
      .mockImplementationOnce(async () => toolCallStream('inspect', 'call-1'))
      .mockImplementationOnce(async () => textStream('First attempt denied.'))
      .mockImplementationOnce(async () => toolCallStream('inspect', 'call-2'))
      .mockImplementation(async () => textStream('Second attempt complete.'));

    await session.sendMessage({ text: 'Inspect the fixture', images: [] }, preferences);
    expect(execute).not.toHaveBeenCalled();
    expect(reviewer).toHaveBeenCalledTimes(1);

    const overrides = await import('../src/review-overrides.js');
    const [denied] = overrides.listDeniedActions();
    expect(denied).toMatchObject({ name: 'inspect' });
    expect(overrides.approveDeniedAction(denied!.fingerprint)).toBeTruthy();

    await session.sendMessage({ text: 'Inspect the fixture again', images: [] }, preferences);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(reviewer).toHaveBeenCalledTimes(2);
    expect(seen[1]).toMatchObject({ userOverride: true });
    expect(seen[0]).not.toHaveProperty('userOverride');
    expect(overrides.listDeniedActions()).toHaveLength(0);
  });

  it('writes reviewed and approved transitions for an allowed action, then executes it', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const session = await startSession((async (options: Record<string, unknown>) => {
      seen.push(options);
      return verdict();
    }) as never);
    await session.sendMessage({ text: 'Inspect the fixture', images: [] }, preferences);

    expect(execute).toHaveBeenCalledTimes(1);
    // The fixture tool declares no workspace scope, so review carries the gate reason.
    expect(seen[0]).toMatchObject({ gateReason: 'unknown-scope' });
    const [row] = ledger.listActions();
    expect(row?.state).toBe('completed');
    expect(ledger.actionTransitions(row!.requestId).map((entry) => entry.state)).toEqual([
      'proposed',
      'reviewed',
      'approved',
      'started',
      'completed',
    ]);
    const reviewed = ledger.actionTransitions(row!.requestId).find((entry) => entry.state === 'reviewed');
    expect(reviewed?.detail).toMatchObject({ verdict: 'allow', risk: 'moderate' });
    expect(session.getSnapshot().session.entries.some((entry) => entry.kind === 'assistant')).toBe(true);
    // One status row: "checking" is replaced in place by the decided state, carrying the reason.
    const reviewNotices = session
      .getSnapshot()
      .session.entries.filter((entry) => entry.kind === 'notice' && entry.text.includes('Auto-review checked'));
    expect(reviewNotices).toHaveLength(1);
    expect(reviewNotices[0]).toMatchObject({ text: expect.stringContaining('allow') });
    expect(reviewNotices[0]?.kind === 'notice' && reviewNotices[0].detail).toContain('Within the stated request.');
  });

  it('runs the reviewer on the configured review model when one is set', async () => {
    const seen: unknown[] = [];
    const reviewModel = { provider: 'review-fixture-model' } as never;
    const { AgentSessionController } = await import('../src/agent-session.js');
    controller = new AgentSessionController({ ...runtime(), reviewModel }, (action) => ledger.recordToolAction(action), {
      autoReviewer: (async (options: { model: unknown }) => {
        seen.push(options.model);
        return verdict();
      }) as never,
    });
    await controller.sendMessage({ text: 'Inspect the fixture', images: [] }, preferences);
    expect(seen[0]).toBe(reviewModel);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('denies without executing and stops nothing else when the reviewer rejects the action', async () => {
    const session = await startSession(async () => verdict({ verdict: 'deny', risk: 'high', reason: 'Outside the request.' }));
    await session.sendMessage({ text: 'Inspect the fixture', images: [] }, preferences);

    expect(execute).not.toHaveBeenCalled();
    const [row] = ledger.listActions();
    expect(row?.state).toBe('denied');
    expect(ledger.actionTransitions(row!.requestId).map((entry) => entry.state)).toEqual(['proposed', 'reviewed', 'denied']);
    const decided = session
      .getSnapshot()
      .session.entries.filter((entry) => entry.kind === 'notice' && entry.text.includes('Auto-review checked'));
    expect(decided).toHaveLength(1);
    expect(decided[0]).toMatchObject({ text: expect.stringContaining('denied') });
  });

  it('escalates to the user, records why, and executes only after the human allows it', async () => {
    const session = await startSession(async () => verdict({ verdict: 'escalate', confidence: 'medium', reason: 'Not enough evidence.' }));

    const sending = session.sendMessage({ text: 'Inspect the fixture', images: [] }, preferences);
    await vi.waitFor(() => expect(session.getSnapshot().pendingApprovalId).toBeTruthy());
    const [row] = ledger.listActions();
    expect(ledger.actionTransitions(row!.requestId).map((entry) => entry.state)).toEqual(['proposed', 'reviewed']);
    expect(row?.state).toBe('reviewed');
    expect(execute).not.toHaveBeenCalled();

    session.approveToolCall('allow', session.getSnapshot().pendingApprovalId!);
    await sending;

    expect(execute).toHaveBeenCalledTimes(1);
    expect(ledger.actionTransitions(row!.requestId).map((entry) => entry.state)).toEqual([
      'proposed',
      'reviewed',
      'approved',
      'started',
      'completed',
    ]);
  });

  it('asks the user when the reviewer is unavailable instead of failing the run', async () => {
    const session = await startSession(async () => ({ status: 'unavailable', code: 'timeout', reason: 'Reviewer timed out.' }));

    const sending = session.sendMessage({ text: 'Inspect the fixture', images: [] }, preferences);
    await vi.waitFor(() => expect(session.getSnapshot().pendingApprovalId).toBeTruthy());

    const [row] = ledger.listActions();
    expect(ledger.actionTransitions(row!.requestId).map((entry) => entry.state)).toEqual(['proposed', 'review_unavailable']);
    expect(execute).not.toHaveBeenCalled();

    session.approveToolCall('deny', session.getSnapshot().pendingApprovalId!);
    await sending;

    expect(execute).not.toHaveBeenCalled();
    expect(ledger.listActions()[0]?.state).toBe('denied');
  });

  it('keeps the decision when only the verdict annotation cannot be recorded', async () => {
    const refused: string[] = [];
    const { AgentSessionController } = await import('../src/agent-session.js');
    controller = new AgentSessionController(
      runtime(),
      (action) => {
        if (action.state === 'reviewed' || action.state === 'review_unavailable') {
          refused.push(action.state);
          throw new Error('annotation write refused');
        }
        ledger.recordToolAction(action);
      },
      { autoReviewer: (async () => verdict()) as never },
    );

    await controller.sendMessage({ text: 'Inspect the fixture', images: [] }, preferences);

    expect(refused).toEqual(['reviewed']);
    expect(execute).toHaveBeenCalledTimes(1);
    const [row] = ledger.listActions();
    expect(ledger.actionTransitions(row!.requestId).map((entry) => entry.state)).toEqual(['proposed', 'approved', 'started', 'completed']);
    const notices = controller.getSnapshot().session.entries.filter((entry) => entry.kind === 'notice');
    expect(notices.some((entry) => entry.kind === 'notice' && entry.text.includes('could not record the auto-review verdict'))).toBe(true);
  });

  it('still refuses to execute when the durable approval record cannot be written', async () => {
    const { AgentSessionController } = await import('../src/agent-session.js');
    controller = new AgentSessionController(
      runtime(),
      (action) => {
        if (action.state === 'approved') throw new Error('approval record refused');
        ledger.recordToolAction(action);
      },
      { autoReviewer: (async () => verdict()) as never },
    );

    await controller.sendMessage({ text: 'Inspect the fixture', images: [] }, preferences);

    expect(execute).not.toHaveBeenCalled();
    const [row] = ledger.listActions();
    expect(row?.state).toBe('failed');
    expect(ledger.actionTransitions(row!.requestId).map((entry) => entry.state)).toEqual(['proposed', 'reviewed', 'failed']);
  });
});
