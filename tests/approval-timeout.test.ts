import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { MockLanguageModelV3 } from 'ai/test';
import type { LanguageModelV3StreamPart } from '@ai-sdk/provider';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { ActivityLedger } from '../src/activity-ledger.js';
import type { AgentEnvironment, AgentSessionController } from '../src/agent-session.js';
import { ToolRegistry, type ToolApprovalResponse, type ToolExecutionContext } from '../src/tools/registry.js';

/**
 * Manual approvals expire instead of hanging the run, and the model is told
 * what happened: a timeout is unanswered, not refused, and a review allow is
 * marked on the result it produced.
 */

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

interface ModelTool {
  execute: (input: Record<string, unknown>, execOptions?: { toolCallId?: string }) => Promise<unknown>;
  toModelOutput?: (args: { output: unknown }) => Promise<unknown>;
}

async function buildModelTool(approve: () => Promise<ToolApprovalResponse>) {
  const registry = new ToolRegistry();
  registry.register({
    providerId: 'host',
    name: 'inspect',
    description: 'Fixture tool for approval outcomes',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    effect: { change: 'none', data: 'local', network: 'none', reversible: 'full', outbound: 'model' },
    execute: async () => ({ status: 'completed', detail: 'fixture result' }),
  });
  const seen: unknown[] = [];
  const bundle = await registry.createModelTools({
    approve,
    onResult: (_request, result) => {
      seen.push(result);
    },
  });
  const entry = Object.values(bundle.tools)[0] as unknown as ModelTool;
  return { entry, seen, shouldStop: bundle.shouldStop };
}

describe('approval outcomes at the registry', () => {
  it('reports an approval timeout as unanswered without stopping the run', async () => {
    const { entry, shouldStop } = await buildModelTool(async () => ({
      approved: false,
      source: 'approval-timeout',
      reason: 'Nobody approved or declined within 45 seconds.',
      timeoutSeconds: 45,
    }));
    const output = (await entry.execute({}, { toolCallId: 'call-1' })) as Record<string, unknown>;
    expect(output.status).toBe('denied');
    expect(String(output.error)).toContain('No approval decision within 45 seconds');
    expect(String(output.error)).toContain('not a refusal on the merits');
    expect(shouldStop()).toBe(false);
  });

  it('still stops the run on an explicit human decline', async () => {
    const { entry, shouldStop } = await buildModelTool(async () => false);
    const output = (await entry.execute({}, { toolCallId: 'call-1' })) as Record<string, unknown>;
    // The run's timing rides beside the tool's own answer; it never replaces it.
    expect(output).toMatchObject({ status: 'denied', error: 'The user declined this tool call. It was not run.' });
    expect(typeof output.openbutlerTiming).toBe('string');
    expect(shouldStop()).toBe(true);
  });

  it('marks a reviewed allow on the model output without touching the stored result', async () => {
    const { entry, seen } = await buildModelTool(async () => ({
      approved: true,
      source: 'auto-review',
      reason: 'Within the stated request.',
      risk: 'low',
    }));
    const output = await entry.execute({}, { toolCallId: 'call-1' });
    // The tool's payload is unchanged; the stamp rides the same result object.
    expect(output).toMatchObject({ status: 'completed', detail: 'fixture result' });
    expect(seen).toEqual([output]);
    const modelOutput = (await entry.toModelOutput?.({ output })) as { type: string; value: string };
    expect(modelOutput.type).toBe('text');
    expect(modelOutput.value).toContain('"fixture result"');
    expect(modelOutput.value).toContain('Auto-review checked and allowed this action (low risk).');
  });

  it('leaves unreviewed results exactly as the default serialization', async () => {
    const { entry } = await buildModelTool(async () => true);
    const output = await entry.execute({}, { toolCallId: 'call-1' });
    const modelOutput = (await entry.toModelOutput?.({ output })) as { type: string; value: unknown };
    // The SDK default carries the raw object by reference; the wrapper must not stringify it.
    expect(modelOutput).toEqual({ type: 'json', value: output });
    expect(JSON.stringify(modelOutput)).not.toContain('Auto-review');
  });
});

describe('manual approval expiry in a session', () => {
  let root: string;
  let previousDataDir: string | undefined;
  let ledger: ActivityLedger;
  let model: MockLanguageModelV3;
  let execute: Mock<(input: Record<string, unknown>, signal?: AbortSignal, context?: ToolExecutionContext) => Promise<unknown>>;
  let controller: AgentSessionController | undefined;

  beforeEach(() => {
    previousDataDir = process.env.OPENBUTLER_DATA_DIR;
    root = mkdtempSync(join(tmpdir(), 'openbutler-approval-timeout-'));
    process.env.OPENBUTLER_DATA_DIR = root;
    vi.resetModules();
    ledger = new ActivityLedger(join(root, 'state.db'));
    execute = vi.fn<(input: Record<string, unknown>, signal?: AbortSignal, context?: ToolExecutionContext) => Promise<unknown>>(
      async () => ({ status: 'completed', detail: 'fixture result' }),
    );
    model = new MockLanguageModelV3({
      doGenerate: async () => ({
        content: [{ type: 'text' as const, text: '{"title":"Approval fixture"}' }],
        finishReason: { unified: 'stop' as const, raw: 'stop' as const },
        usage,
        warnings: [],
      }),
      doStream: vi
        .fn()
        .mockImplementationOnce(async () => toolCallStream('inspect', 'call-1'))
        .mockImplementation(async () => textStream('Continuing without that action.')),
    });
  });

  afterEach(async () => {
    await controller?.close();
    controller = undefined;
    ledger.close();
    if (previousDataDir === undefined) delete process.env.OPENBUTLER_DATA_DIR;
    else process.env.OPENBUTLER_DATA_DIR = previousDataDir;
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith('openbutler-approval-timeout-')) {
      throw new Error('Refusing to remove a directory outside this test fixture.');
    }
    rmSync(root, { recursive: true, force: true });
  });

  it('expires an unanswered approval and lets the run continue', async () => {
    writeFileSync(join(root, 'settings.yaml'), 'approvalTimeoutSeconds: 5\n', 'utf8');
    const registry = new ToolRegistry();
    registry.register({
      providerId: 'host',
      name: 'inspect',
      description: 'Fixture tool that waits for a human',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      effect: { change: 'none', data: 'local', network: 'none', reversible: 'full', outbound: 'model' },
      execute,
    });
    const environment: AgentEnvironment = {
      model,
      workspaceRoot: process.cwd(),
      modelName: 'Approval fixture',
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
      approvalMode: 'workspace',
      getReasoningProviderOptions: () => ({}),
      getReviewProviderOptions: () => ({}),
      registry,
      selectModel: async () => {},
      close: async () => {},
    };
    const { AgentSessionController } = await import('../src/agent-session.js');
    controller = new AgentSessionController(environment, (action) => ledger.recordToolAction(action));
    await controller.sendMessage({ text: 'Inspect the fixture', images: [] }, preferences);

    expect(execute).not.toHaveBeenCalled();
    const entries = controller.getSnapshot().session.entries;
    expect(entries.some((entry) => entry.kind === 'notice' && entry.text.includes('No approval decision within 5 seconds'))).toBe(true);
    const [row] = ledger.listActions();
    expect(row?.state).toBe('denied');
    // The run continued past the expired prompt to a final answer.
    expect(model.doStreamCalls).toHaveLength(2);
    expect(entries.some((entry) => entry.kind === 'assistant' && entry.text.includes('Continuing without that action.'))).toBe(true);
  }, 30_000);
});
