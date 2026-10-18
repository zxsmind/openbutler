import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { MockLanguageModelV3 } from 'ai/test';
import type { LanguageModelV3StreamPart, LanguageModelV3StreamResult } from '@ai-sdk/provider';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEnvironment, AgentSessionController } from '../src/agent-session.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { shouldWakeForTeamDms } from '../src/team/service.js';

const usage = {
  inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 20, text: 20, reasoning: 0 },
};

type StreamStep = LanguageModelV3StreamPart | { pause: number };

function delayedStream(steps: StreamStep[], finishReason: 'stop' | 'tool-calls' = 'stop'): LanguageModelV3StreamResult {
  return {
    stream: new ReadableStream({
      async start(controller) {
        controller.enqueue({ type: 'stream-start', warnings: [] });
        for (const step of steps) {
          if ('pause' in step) await delay(step.pause);
          else controller.enqueue(step);
        }
        controller.enqueue({
          type: 'finish',
          finishReason: { unified: finishReason, raw: finishReason },
          usage: { ...usage },
        });
        controller.close();
      },
    }),
  };
}

function runtimeFor(model: MockLanguageModelV3, registry: ToolRegistry): AgentEnvironment {
  return {
    model,
    workspaceRoot: process.cwd(),
    modelName: 'Local streaming fixture',
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
    showReasoningDefault: true,
    saveShowReasoningPreference: () => {},
    getReasoningProviderOptions: () => ({}),
    getReviewProviderOptions: () => ({}),
    registry,
    selectModel: async () => {},
    close: async () => {},
  };
}

function titleResponse() {
  return {
    content: [{ type: 'text' as const, text: '{"title":"Fixture greeting"}' }],
    finishReason: { unified: 'stop' as const, raw: 'stop' },
    usage,
    warnings: [],
  };
}

function fixtureText(text: string): LanguageModelV3StreamResult {
  return delayedStream([
    { type: 'text-start', id: 'fixture' },
    { type: 'text-delta', id: 'fixture', delta: text },
    { type: 'text-end', id: 'fixture' },
  ]);
}

let dataDir: string;
let previousDataDir: string | undefined;
let session: AgentSessionController | undefined;

beforeEach(() => {
  previousDataDir = process.env.RANITE_DATA_DIR;
  dataDir = mkdtempSync(join(tmpdir(), 'ranite-team-steer-'));
  process.env.RANITE_DATA_DIR = dataDir;
  vi.resetModules();
});

afterEach(async () => {
  await session?.close();
  session = undefined;
  if (previousDataDir === undefined) delete process.env.RANITE_DATA_DIR;
  else process.env.RANITE_DATA_DIR = previousDataDir;
  if (dirname(resolve(dataDir)) !== resolve(tmpdir()) || !basename(dataDir).startsWith('ranite-team-steer-')) {
    throw new Error('Refusing to remove a directory outside this test fixture.');
  }
  rmSync(dataDir, { recursive: true, force: true });
});

const preferences = { reasoningVariantId: 'default', showReasoning: true };

async function setupBusyRun() {
  let started = false;
  let release!: () => void;
  const gate = new Promise<void>((resolveGate) => {
    release = resolveGate;
  });
  const registry = new ToolRegistry();
  registry.register({
    providerId: 'host',
    name: 'inspect',
    description: 'Fixture',
    inputSchema: { type: 'object', properties: {} },
    effect: { change: 'none', data: 'local', network: 'none', reversible: 'full', outbound: 'model' },
    autoApprove: () => true,
    execute: async () => {
      started = true;
      await gate;
      return { message: 'tool done' };
    },
  });
  const model = new MockLanguageModelV3({
    doGenerate: async () => titleResponse(),
    doStream: vi
      .fn()
      .mockImplementationOnce(async () =>
        delayedStream(
          [
            { type: 'text-start', id: 'before' },
            { type: 'text-delta', id: 'before', delta: 'Looking into it.' },
            { type: 'text-end', id: 'before' },
            { type: 'tool-call', toolCallId: 'one', toolName: 'inspect', input: '{}' },
          ],
          'tool-calls',
        ),
      )
      .mockImplementation(async () => fixtureText('Done.')),
  });
  const { AgentSessionController } = await import('../src/agent-session.js');
  // sessionWorkspaceRoot: null is the custodian, where a team wake lands and steering is allowed.
  session = new AgentSessionController(runtimeFor(model, registry), undefined, { sessionWorkspaceRoot: null });
  const first = session.sendMessage(
    { text: 'Start the long task.', images: [], eventId: 'first', communication: { source: 'terminal', replyTo: { channel: 'terminal' } } },
    preferences,
  );
  await vi.waitFor(() => expect(started).toBe(true));
  return { model, release, first };
}

describe('team wake steering', () => {
  it('steers a team direct message into a busy run', async () => {
    const { model, release, first } = await setupBusyRun();
    const second = session!.sendMessage({ text: 'TEAM_NOTE', images: [], eventId: 'team', communication: { source: 'team' } }, preferences);
    release();
    await Promise.all([first, second]);
    const prompts = model.doStreamCalls.map((call) => JSON.stringify(call.prompt));
    // Steered: the live run's next step sees the team text, with no extra run.
    expect(model.doStreamCalls).toHaveLength(2);
    expect(prompts[1]).toContain('TEAM_NOTE');
    expect(prompts[1]).toContain('[Host context: inbox notification]');
  });

  it('still steers a same-route owner message', async () => {
    const { model, release, first } = await setupBusyRun();
    const second = session!.sendMessage(
      { text: 'OWNER_NOTE', images: [], eventId: 'owner', communication: { source: 'terminal', replyTo: { channel: 'terminal' } } },
      preferences,
    );
    release();
    await Promise.all([first, second]);
    const prompts = model.doStreamCalls.map((call) => JSON.stringify(call.prompt));
    expect(model.doStreamCalls).toHaveLength(2);
    expect(prompts[1]).toContain('OWNER_NOTE');
  });

  it('decides a wake on the cursor alone, independent of busy state', () => {
    expect(shouldWakeForTeamDms({ count: 1, highestSeq: 6, seenSeq: 5 })).toBe(true);
    expect(shouldWakeForTeamDms({ count: 1, highestSeq: 5, seenSeq: 5 })).toBe(false);
    expect(shouldWakeForTeamDms({ count: 0, highestSeq: 9, seenSeq: 0 })).toBe(false);
  });
});

it('withdraws an obsolete team wake before it enters a busy conversation', async () => {
  const { model, release, first } = await setupBusyRun();
  const stale = session!.sendMessage(
    { text: 'STALE_TEAM_SIGNAL', images: [], eventId: 'stale-team', communication: { source: 'team' }, beforeDelivery: async () => null },
    preferences,
  );
  release();
  await Promise.all([first, stale]);
  expect(model.doStreamCalls).toHaveLength(2);
  expect(JSON.stringify(model.doStreamCalls)).not.toContain('STALE_TEAM_SIGNAL');
  expect(session!.takeEventRunResult('stale-team')).toEqual({ error: null, outputs: [], skipped: true });
});

it('steers a worker lifecycle event into a busy parent at the tool boundary', async () => {
  const { model, release, first } = await setupBusyRun();
  const signal = session!.sendEvent(
    { text: 'WORKER_RESULT_READY', images: [], eventId: 'worker-complete', communication: { source: 'inbox' } },
    preferences,
  );
  release();
  await Promise.all([first, signal]);
  expect(model.doStreamCalls).toHaveLength(2);
  expect(JSON.stringify(model.doStreamCalls[1]?.prompt)).toContain('WORKER_RESULT_READY');
  expect(JSON.stringify(model.doStreamCalls[1]?.prompt)).toContain('[Host context: inbox notification]');
});

it('preserves an owner stop across saves and releases it only on explicit input', async () => {
  const { release, first } = await setupBusyRun();
  session!.stop({ holdQueue: true });
  release();
  await first;
  session!.flushSave();
  const { loadSavedSession } = await import('../src/session-store.js');
  const saved = loadSavedSession(session!.getSnapshot().session.id)!;
  expect(saved.automaticWakeHeld).toBe(true);
  await expect(session!.sendEvent({ text: 'automatic', images: [], communication: { source: 'inbox' } }, preferences)).rejects.toThrow(
    'held',
  );
  await session!.sendMessage(
    { text: 'Resume the task.', images: [], communication: { source: 'terminal', replyTo: { channel: 'terminal' } } },
    preferences,
  );
  expect(session!.automaticWakeHeld).toBe(false);
});
