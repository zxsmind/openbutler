import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { MockLanguageModelV3 } from 'ai/test';
import type { LanguageModelV3StreamPart, LanguageModelV3StreamResult } from '@ai-sdk/provider';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEnvironment, AgentSessionController } from '../src/agent-session.js';
import type { ModelMessage } from 'ai';
import { ToolRegistry } from '../src/tools/registry.js';

const usage = {
  inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 20, text: 20, reasoning: 0 },
};

type StreamStep = LanguageModelV3StreamPart | { pause: number };

function delayedStream(
  steps: StreamStep[],
  finishReason: 'stop' | 'tool-calls' | 'length' = 'stop',
  inputTokens = 100,
): LanguageModelV3StreamResult {
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
          usage: { ...usage, inputTokens: { ...usage.inputTokens, total: inputTokens, noCache: inputTokens } },
        });
        controller.close();
      },
    }),
  };
}

function runtimeFor(model: MockLanguageModelV3, registry = new ToolRegistry()): AgentEnvironment {
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

let dataDir: string;
let previousDataDir: string | undefined;
let session: AgentSessionController | undefined;

beforeEach(() => {
  previousDataDir = process.env.RANITE_DATA_DIR;
  dataDir = mkdtempSync(join(tmpdir(), 'ranite-session-stream-'));
  process.env.RANITE_DATA_DIR = dataDir;
  vi.resetModules();
});

afterEach(async () => {
  await session?.close();
  session = undefined;
  if (previousDataDir === undefined) delete process.env.RANITE_DATA_DIR;
  else process.env.RANITE_DATA_DIR = previousDataDir;
  if (dirname(resolve(dataDir)) !== resolve(tmpdir()) || !basename(dataDir).startsWith('ranite-session-stream-')) {
    throw new Error('Refusing to remove a directory outside this test fixture.');
  }
  rmSync(dataDir, { recursive: true, force: true });
});

const preferences = { reasoningVariantId: 'default', showReasoning: true };

function fixtureText(text: string, finishReason: 'stop' | 'length' = 'stop', inputTokens = 100) {
  return delayedStream(
    [
      { type: 'text-start', id: 'fixture' },
      { type: 'text-delta', id: 'fixture', delta: text },
      { type: 'text-end', id: 'fixture' },
    ],
    finishReason,
    inputTokens,
  );
}

describe('owner replies and safe steering', () => {
  it('steers actual owner text after tool results, shares one reply, and excludes tool traces', async () => {
    let started = false;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
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
        return { message: 'private tool trace' };
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
        .mockImplementationOnce(async () => fixtureText('Your new request has been taken into account.')),
    });
    const { AgentSessionController } = await import('../src/agent-session.js');
    session = new AgentSessionController(runtimeFor(model, registry), undefined, { sessionWorkspaceRoot: null });
    const communication = { source: 'telegram' as const, replyTo: { channel: 'telegram' as const, chatId: '42' } };
    const first = session.sendMessage({ text: 'Review it.', images: [], eventId: 'first', communication }, preferences);
    await vi.waitFor(() => expect(started).toBe(true));
    const second = session.sendMessage({ text: 'Do not delete, only read.', images: [], eventId: 'second', communication }, preferences);
    release();
    await Promise.all([first, second]);
    expect(model.doStreamCalls).toHaveLength(2);
    const prompt = model.doStreamCalls[1]!.prompt;
    const steerIndex = prompt.findIndex(
      (message) => message.role === 'user' && JSON.stringify(message.content).includes('Do not delete, only read.'),
    );
    expect(steerIndex).toBeGreaterThan(0);
    expect(prompt[steerIndex - 1]!.role).toBe('tool');
    expect(
      prompt.filter((message) => message.role === 'user' && JSON.stringify(message.content).includes('Do not delete, only read.')),
    ).toHaveLength(1);
    expect(JSON.stringify(prompt)).toContain('[Host context: owner message via Telegram]');
    expect(JSON.stringify(prompt)).toContain('reply through send_message_to_owner');
    expect(JSON.stringify(prompt)).not.toContain('telegramAvailable');
    expect(session.takeEventRunResult('first')).toEqual({
      error: null,
      outputs: [
        { kind: 'assistant', text: 'Looking into it.' },
        { kind: 'assistant', text: 'Your new request has been taken into account.' },
      ],
    });
    expect(session.takeEventRunResult('second')).toEqual({ error: null, outputs: [], replyHandledByEventId: 'first' });
  });

  it('drains every compatible queued message in the same steering gap', async () => {
    let started = false;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
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
        return { message: 'Tool completed' };
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
        .mockImplementationOnce(async () => fixtureText('All three requests have been taken into account.')),
    });
    const { AgentSessionController } = await import('../src/agent-session.js');
    session = new AgentSessionController(runtimeFor(model, registry), undefined, { sessionWorkspaceRoot: null });
    const terminal = { source: 'terminal' as const, replyTo: { channel: 'terminal' as const } };
    const first = session.sendMessage({ text: 'First task.', images: [], communication: terminal }, preferences);
    await vi.waitFor(() => expect(started).toBe(true));
    const second = session.sendMessage({ text: 'Second note alpha.', images: [], communication: terminal }, preferences);
    const third = session.sendMessage({ text: 'Third note beta.', images: [], communication: terminal }, preferences);
    const fourth = session.sendMessage({ text: 'Fourth note gamma.', images: [], communication: terminal }, preferences);
    release();
    await Promise.all([first, second, third, fourth]);
    // One initial step plus a single steered step carrying the whole burst.
    expect(model.doStreamCalls).toHaveLength(2);
    const prompt = JSON.stringify(model.doStreamCalls[1]!.prompt);
    expect(prompt).toContain('Second note alpha.');
    expect(prompt).toContain('Third note beta.');
    expect(prompt).toContain('Fourth note gamma.');
    expect(session.getSnapshot().queuedMessageCount).toBe(0);
  });

  it('finalizes an empty direct reply once without repeating tools', async () => {
    const model = new MockLanguageModelV3({
      doGenerate: async () => titleResponse(),
      doStream: vi
        .fn()
        .mockImplementationOnce(async () => delayedStream([]))
        .mockImplementationOnce(async () => fixtureText('Hello!')),
    });
    const { AgentSessionController } = await import('../src/agent-session.js');
    session = new AgentSessionController(runtimeFor(model), undefined, { sessionWorkspaceRoot: null });
    await session.sendMessage(
      {
        text: 'hello',
        images: [],
        eventId: 'hello',
        communication: { source: 'telegram', replyTo: { channel: 'telegram', chatId: '42' } },
      },
      preferences,
    );
    expect(model.doStreamCalls).toHaveLength(2);
    expect(model.doStreamCalls[1]!.tools ?? []).toHaveLength(0);
    expect(session.takeEventRunResult('hello')).toEqual({ error: null, outputs: [{ kind: 'assistant', text: 'Hello!' }] });
  });

  it('keeps a changed reply route as a followup and gives each route its own output', async () => {
    let next: Promise<void> | undefined;
    const registry = new ToolRegistry();
    registry.register({
      providerId: 'host',
      name: 'inspect',
      description: 'Fixture',
      inputSchema: { type: 'object', properties: {} },
      effect: { change: 'none', data: 'local', network: 'none', reversible: 'full', outbound: 'model' },
      autoApprove: () => true,
      execute: async () => {
        next = session!.sendMessage(
          {
            text: 'Terminal followup',
            images: [],
            eventId: 'terminal',
            communication: { source: 'terminal', replyTo: { channel: 'terminal' } },
          },
          preferences,
        );
        return { message: 'Tool completed' };
      },
    });
    const model = new MockLanguageModelV3({
      doGenerate: async () => titleResponse(),
      doStream: vi
        .fn()
        .mockImplementationOnce(async () =>
          delayedStream([{ type: 'tool-call', toolCallId: 'one', toolName: 'inspect', input: '{}' }], 'tool-calls'),
        )
        .mockImplementationOnce(async () => fixtureText('Telegram answer'))
        .mockImplementationOnce(async () => fixtureText('Terminal answer')),
    });
    const { AgentSessionController } = await import('../src/agent-session.js');
    session = new AgentSessionController(runtimeFor(model, registry), undefined, { sessionWorkspaceRoot: null });
    await session.sendMessage(
      {
        text: 'Telegram request',
        images: [],
        eventId: 'telegram',
        communication: { source: 'telegram', replyTo: { channel: 'telegram', chatId: '42' } },
      },
      preferences,
    );
    await next;
    expect(model.doStreamCalls).toHaveLength(3);
    expect(JSON.stringify(model.doStreamCalls[1]!.prompt)).not.toContain('Terminal followup');
    expect(session.takeEventRunResult('telegram')?.outputs).toEqual([{ kind: 'assistant', text: 'Telegram answer' }]);
    expect(session.takeEventRunResult('terminal')?.outputs).toEqual([{ kind: 'assistant', text: 'Terminal answer' }]);
  });

  it('preserves every assistant segment across tools without including their output or reasoning', async () => {
    const answers = ['Looking into it.', 'I found something.', 'Long answer '.repeat(600), 'Yes, that is how it is.'];
    let call = 0;
    const registry = new ToolRegistry();
    registry.register({
      providerId: 'host',
      name: 'inspect',
      description: 'Fixture',
      inputSchema: { type: 'object', properties: {} },
      effect: { change: 'none', data: 'local', network: 'none', reversible: 'full', outbound: 'model' },
      autoApprove: () => true,
      execute: async () => ({ message: 'Internal tool output' }),
    });
    const model = new MockLanguageModelV3({
      doGenerate: async () => titleResponse(),
      doStream: async () => {
        const index = call++;
        return delayedStream(
          [
            { type: 'reasoning-start', id: `r${index}` },
            { type: 'reasoning-delta', id: `r${index}`, delta: 'Private reasoning' },
            { type: 'reasoning-end', id: `r${index}` },
            { type: 'text-start', id: `t${index}` },
            { type: 'text-delta', id: `t${index}`, delta: answers[index]! },
            { type: 'text-end', id: `t${index}` },
            ...(index < 3 ? [{ type: 'tool-call' as const, toolCallId: `call${index}`, toolName: 'inspect', input: '{}' }] : []),
          ],
          index < 3 ? 'tool-calls' : 'stop',
        );
      },
    });
    const { AgentSessionController } = await import('../src/agent-session.js');
    session = new AgentSessionController(runtimeFor(model, registry), undefined, { sessionWorkspaceRoot: null });
    await session.sendMessage(
      {
        text: 'Inspect',
        images: [],
        eventId: 'all',
        communication: { source: 'telegram', replyTo: { channel: 'telegram', chatId: '42' } },
      },
      preferences,
    );
    expect(session.takeEventRunResult('all')?.outputs.map((output) => output.text)).toEqual(answers);
  });

  it('reports a missing answer after one finalization instead of retrying indefinitely', async () => {
    const model = new MockLanguageModelV3({ doGenerate: async () => titleResponse(), doStream: async () => delayedStream([]) });
    const { AgentSessionController } = await import('../src/agent-session.js');
    session = new AgentSessionController(runtimeFor(model));
    await session.sendMessage(
      { text: 'Hello', images: [], communication: { source: 'terminal', replyTo: { channel: 'terminal' } } },
      preferences,
    );
    expect(model.doStreamCalls).toHaveLength(2);
    expect(session.getLastRunError()).toContain('without a user-facing answer');
  });
});

describe('session streaming message boundaries', () => {
  it('keeps reasoning and assistant deltas in one entry across multiple repaint timers', async () => {
    const model = new MockLanguageModelV3({
      doGenerate: async () => titleResponse(),
      doStream: async () =>
        delayedStream([
          { type: 'reasoning-start', id: 'reasoning' },
          { type: 'reasoning-delta', id: 'reasoning', delta: 'A simple ' },
          { pause: 80 },
          { type: 'reasoning-delta', id: 'reasoning', delta: 'greeting.' },
          { type: 'reasoning-end', id: 'reasoning' },
          { type: 'text-start', id: 'answer' },
          { type: 'text-delta', id: 'answer', delta: 'Hello! 👋 How ca' },
          { pause: 80 },
          { type: 'text-delta', id: 'answer', delta: 'n I help ' },
          { pause: 80 },
          { type: 'text-delta', id: 'answer', delta: 'you today?' },
          { type: 'text-end', id: 'answer' },
        ]),
    });
    const { AgentSessionController } = await import('../src/agent-session.js');
    session = new AgentSessionController(runtimeFor(model));
    await session.sendMessage({ text: 'selam', images: [] }, preferences);

    const snapshot = session.getSnapshot();
    expect(snapshot.session.entries.filter((entry) => entry.kind === 'reasoning')).toEqual([
      { kind: 'reasoning', text: 'A simple greeting.' },
    ]);
    expect(snapshot.session.entries.filter((entry) => entry.kind === 'assistant')).toEqual([
      { kind: 'assistant', text: 'Hello! 👋 How can I help you today?' },
    ]);
    expect(snapshot.streamingAssistantEntry).toBeNull();
    expect(snapshot.busy).toBe(false);
  });

  it('starts a new assistant entry at a real tool boundary while joining deltas on both sides', async () => {
    const registry = new ToolRegistry();
    registry.register({
      providerId: 'host',
      name: 'inspect',
      description: 'A local fixture tool',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      effect: { change: 'none', data: 'local', network: 'none', reversible: 'full', outbound: 'model' },
      autoApprove: () => true,
      execute: async () => ({ status: 'completed', detail: 'Fixture result' }),
    });
    const model = new MockLanguageModelV3({
      doGenerate: async () => titleResponse(),
      doStream: vi
        .fn()
        .mockImplementationOnce(async () =>
          delayedStream(
            [
              { type: 'text-start', id: 'before' },
              { type: 'text-delta', id: 'before', delta: 'Checking ' },
              { pause: 80 },
              { type: 'text-delta', id: 'before', delta: 'the result.' },
              { type: 'text-end', id: 'before' },
              { type: 'tool-call', toolCallId: 'inspect-1', toolName: 'inspect', input: '{}' },
            ],
            'tool-calls',
          ),
        )
        .mockImplementationOnce(async () =>
          delayedStream([
            { type: 'text-start', id: 'after' },
            { type: 'text-delta', id: 'after', delta: 'Completed ' },
            { pause: 80 },
            { type: 'text-delta', id: 'after', delta: 'successfully.' },
            { type: 'text-end', id: 'after' },
          ]),
        ),
    });
    const { AgentSessionController } = await import('../src/agent-session.js');
    session = new AgentSessionController(runtimeFor(model, registry));
    await session.sendMessage({ text: 'inspect', images: [] }, preferences);

    const entries = session.getSnapshot().session.entries;
    expect(entries.map((entry) => entry.kind)).toEqual(['user', 'assistant', 'tool', 'assistant']);
    expect(entries[1]).toEqual({ kind: 'assistant', text: 'Checking the result.' });
    expect(entries[2]).toMatchObject({ kind: 'tool', running: false });
    expect(entries[3]).toEqual({ kind: 'assistant', text: 'Completed successfully.' });
  });

  it('previews a tool call while its arguments stream, then shows the executed form', async () => {
    const registry = new ToolRegistry();
    registry.register({
      providerId: 'host',
      name: 'file_write',
      description: 'A local fixture tool',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string' }, content: { type: 'string' } },
        required: ['path', 'content'],
        additionalProperties: false,
      },
      effect: { change: 'none', data: 'local', network: 'none', reversible: 'full', outbound: 'model' },
      autoApprove: () => true,
      execute: async () => ({ status: 'completed', stdout: 'Saved fixture file', stderr: '' }),
    });
    let continueStream!: () => void;
    const streamGate = new Promise<void>((resolve) => {
      continueStream = resolve;
    });
    const model = new MockLanguageModelV3({
      doGenerate: async () => titleResponse(),
      doStream: vi
        .fn()
        .mockImplementationOnce(async () => ({
          stream: new ReadableStream({
            async start(controller) {
              controller.enqueue({ type: 'stream-start', warnings: [] });
              controller.enqueue({ type: 'tool-input-start', id: 'write-1', toolName: 'file_write' });
              controller.enqueue({ type: 'tool-input-delta', id: 'write-1', delta: '{"path":"src/r' });
              controller.enqueue({ type: 'tool-input-delta', id: 'write-1', delta: 'untime.ts","content":"export const x = 1;"}' });
              await streamGate;
              controller.enqueue({ type: 'tool-input-end', id: 'write-1' });
              controller.enqueue({
                type: 'tool-call',
                toolCallId: 'write-1',
                toolName: 'file_write',
                input: '{"path":"src/runtime.ts","content":"export const x = 1;"}',
              });
              controller.enqueue({ type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool-calls' }, usage });
              controller.close();
            },
          }),
        }))
        .mockImplementationOnce(async () => fixtureText('Saved it.')),
    });
    const { AgentSessionController } = await import('../src/agent-session.js');
    session = new AgentSessionController(runtimeFor(model, registry));
    const run = session.sendMessage({ text: 'write the file', images: [] }, preferences);

    try {
      await vi.waitFor(() => {
        const entry = session!.getSnapshot().session.entries.find((candidate) => candidate.kind === 'tool');
        expect(entry).toEqual({ kind: 'tool', command: 'Write src/runtime.ts', result: '', preparing: true, tool: 'host:file_write' });
      });
      expect(session.getSnapshot().session.entries.some((entry) => entry.kind === 'tool' && entry.result === 'Saved fixture file')).toBe(
        false,
      );
    } finally {
      continueStream();
    }
    await run;

    const toolEntries = session.getSnapshot().session.entries.filter((entry) => entry.kind === 'tool');
    expect(toolEntries).toEqual([
      { kind: 'tool', command: 'Write src/runtime.ts', result: 'Wrote', running: false, tool: 'host:file_write' },
    ]);
  });

  it('keeps text that keeps streaming after a tool call starts in the same assistant entry', async () => {
    const registry = new ToolRegistry();
    registry.register({
      providerId: 'host',
      name: 'inspect',
      description: 'A local fixture tool',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      effect: { change: 'none', data: 'local', network: 'none', reversible: 'full', outbound: 'model' },
      autoApprove: () => true,
      execute: async () => ({ status: 'completed', detail: 'Fixture result' }),
    });
    const model = new MockLanguageModelV3({
      doGenerate: async () => titleResponse(),
      doStream: vi
        .fn()
        .mockImplementationOnce(async () =>
          delayedStream(
            [
              { type: 'text-start', id: 'answer' },
              { type: 'text-delta', id: 'answer', delta: 'I am updating the notes (' },
              { pause: 80 },
              { type: 'tool-input-start', id: 'inspect-1', toolName: 'inspect' },
              { type: 'tool-input-delta', id: 'inspect-1', delta: '{}' },
              { pause: 80 },
              { type: 'text-delta', id: 'answer', delta: 'including the details).' },
              { type: 'text-end', id: 'answer' },
              { type: 'tool-input-end', id: 'inspect-1' },
              { type: 'tool-call', toolCallId: 'inspect-1', toolName: 'inspect', input: '{}' },
            ],
            'tool-calls',
          ),
        )
        .mockImplementationOnce(async () => fixtureText('Done.')),
    });
    const { AgentSessionController } = await import('../src/agent-session.js');
    session = new AgentSessionController(runtimeFor(model, registry));
    await session.sendMessage({ text: 'inspect', images: [] }, preferences);

    const entries = session.getSnapshot().session.entries;
    expect(entries.map((entry) => entry.kind)).toEqual(['user', 'assistant', 'tool', 'assistant']);
    expect(entries[1]).toEqual({ kind: 'assistant', text: 'I am updating the notes (including the details).' });
    expect(entries[2]).toMatchObject({ kind: 'tool', running: false });
    expect(entries[3]).toEqual({ kind: 'assistant', text: 'Done.' });
  });

  it('keeps a completed tool step in the session if the next provider step fails', async () => {
    const registry = new ToolRegistry();
    registry.register({
      providerId: 'host',
      name: 'inspect',
      description: 'A local fixture tool',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      effect: { change: 'none', data: 'local', network: 'none', reversible: 'full', outbound: 'model' },
      autoApprove: () => true,
      execute: async () => ({ status: 'completed', detail: 'Saved fixture result' }),
    });
    const model = new MockLanguageModelV3({
      doGenerate: async () => titleResponse(),
      doStream: vi
        .fn()
        .mockImplementationOnce(async () =>
          delayedStream(
            [
              { type: 'text-start', id: 'step-one' },
              { type: 'text-delta', id: 'step-one', delta: 'I checked the file.' },
              { type: 'text-end', id: 'step-one' },
              { type: 'tool-call', toolCallId: 'inspect-completed', toolName: 'inspect', input: '{}' },
            ],
            'tool-calls',
          ),
        )
        .mockImplementationOnce(async () => {
          throw new Error('Tool result is missing for tool call later-step.');
        }),
    });
    const { AgentSessionController } = await import('../src/agent-session.js');
    const { loadSavedSession } = await import('../src/session-store.js');
    session = new AgentSessionController(runtimeFor(model, registry));
    const sessionId = session.getSnapshot().session.id;

    await session.sendMessage({ text: 'Inspect, then summarize.', images: [] }, preferences);
    session.flushSave();

    const saved = loadSavedSession(sessionId)!;
    const conversationParts = saved.conversation.flatMap((message) =>
      Array.isArray(message.content) ? (message.content as Array<{ type: string; toolCallId?: string }>) : [],
    );
    const completedExchange = conversationParts.filter((part) => part.toolCallId === 'inspect-completed');
    expect(completedExchange.map((part) => part.type)).toEqual(['tool-call', 'tool-result']);
    expect(JSON.stringify(saved.conversation)).toContain('I checked the file.');
    expect(JSON.stringify(completedExchange)).toContain('Saved fixture result');
    expect(saved.entries.some((entry) => entry.kind === 'notice' && entry.text.includes('later-step'))).toBe(true);
  });
});

describe('session compaction persistence and continuation', () => {
  it('compacts twice in one tool run when the context fills again, preserving queued input and the complete archive', async () => {
    const { AgentSessionController } = await import('../src/agent-session.js');
    const { createSession, loadSavedSession } = await import('../src/session-store.js');
    const { COMPACTION_PROMPT } = await import('../src/compaction.js');
    let normalCalls = 0;
    let summaryCalls = 0;
    const model = new MockLanguageModelV3({
      doStream: async (request) => {
        const last = request.prompt.at(-1);
        if (last?.role === 'user' && last.content.some((part) => part.type === 'text' && part.text === COMPACTION_PROMPT)) {
          return fixtureText(`Checkpoint ${++summaryCalls}: preserve the original task, queued constraints, and all findings.`);
        }
        normalCalls++;
        if (normalCalls === 4) return fixtureText('The original task is complete.', 'stop', 20_000);
        return delayedStream(
          [
            { type: 'reasoning-start', id: `reasoning-${normalCalls}` },
            { type: 'reasoning-delta', id: `reasoning-${normalCalls}`, delta: `Step ${normalCalls} evidence. `.repeat(500) },
            { type: 'reasoning-end', id: `reasoning-${normalCalls}` },
            { type: 'text-start', id: `text-${normalCalls}` },
            { type: 'text-delta', id: `text-${normalCalls}`, delta: `Inspecting result ${normalCalls}.` },
            { type: 'text-end', id: `text-${normalCalls}` },
            { type: 'tool-call', toolCallId: `call-${normalCalls}`, toolName: 'inspect', input: '{}' },
          ],
          'tool-calls',
          normalCalls === 2 ? 20_000 : 90_000,
        );
      },
    });
    const registry = new ToolRegistry();
    let executions = 0;
    registry.register({
      providerId: 'host',
      name: 'inspect',
      description: 'A local fixture tool',
      inputSchema: { type: 'object', properties: {} },
      effect: { change: 'none', data: 'local', network: 'none', reversible: 'full', outbound: 'model' },
      autoApprove: () => true,
      execute: async () => {
        executions++;
        if (executions === 1)
          void session!.sendMessage(
            { text: 'Keep the queued constraint.', images: [], communication: { source: 'terminal', replyTo: { channel: 'terminal' } } },
            preferences,
          );
        return { finding: `Original tool result ${executions}. ` + 'Detailed evidence. '.repeat(1_000) };
      },
    });
    const runtime = runtimeFor(model, registry);
    runtime.contextWindowTokens = 100_000;
    runtime.outputLimitTokens = 20_000;
    const original: ModelMessage[] = [
      { role: 'user', content: 'Original task: inspect both results.' },
      {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'Earlier reasoning. '.repeat(1_000) },
          { type: 'text', text: 'Initial progress.' },
        ],
      },
    ];
    session = new AgentSessionController(runtime, undefined, { sessionWorkspaceRoot: null });
    session.openSession({
      ...createSession('fixture', 'fixture'),
      conversation: original,
      entries: [{ kind: 'user', text: 'Original task: inspect both results.' }],
    });
    const id = session.getSnapshot().session.id;
    await session.sendMessage(
      { text: 'Continue the original task.', images: [], communication: { source: 'terminal', replyTo: { channel: 'terminal' } } },
      preferences,
    );
    session.flushSave();
    expect(summaryCalls).toBe(2);
    expect(normalCalls).toBe(4);
    expect(executions).toBe(3);
    expect(session.getLastRunError()).toBeNull();
    const saved = loadSavedSession(id)!;
    expect(saved.contextTokens).toBe(20_000);
    expect(JSON.stringify(saved.conversation)).toContain('Checkpoint 2:');
    expect(JSON.stringify(saved.conversation)).not.toContain('Checkpoint 1:');
    expect(saved.conversationArchive!.slice(0, original.length)).toEqual(original);
    for (const messages of [saved.conversation, saved.conversationArchive!]) {
      const queued = messages.filter(
        (message) =>
          message.role === 'user' &&
          Array.isArray(message.content) &&
          message.content.some((part) => part.type === 'text' && part.text.includes('Keep the queued constraint.')),
      );
      expect(queued).toHaveLength(1);
    }
    const archivedCalls = saved.conversationArchive!.flatMap((message) =>
      Array.isArray(message.content) ? message.content.filter((part) => part.type === 'tool-call' || part.type === 'tool-result') : [],
    );
    expect(archivedCalls.filter((part) => 'toolCallId' in part && part.toolCallId === 'call-1')).toHaveLength(2);
    expect(archivedCalls.filter((part) => 'toolCallId' in part && part.toolCallId === 'call-2')).toHaveLength(2);
    expect(archivedCalls.filter((part) => 'toolCallId' in part && part.toolCallId === 'call-3')).toHaveLength(2);
    expect(JSON.stringify(saved.conversationArchive)).toContain('Original tool result 1.');
    expect(JSON.stringify(saved.conversationArchive)).toContain('Original tool result 2.');
    expect(JSON.stringify(saved.conversationArchive)).toContain('Original tool result 3.');
  });

  it('preserves completed steps and stops the run if required automatic compaction fails, allowing a later retry', async () => {
    const { AgentSessionController } = await import('../src/agent-session.js');
    const { createSession, loadSavedSession } = await import('../src/session-store.js');
    const { COMPACTION_PROMPT } = await import('../src/compaction.js');
    let normalCalls = 0;
    let summaryCalls = 0;
    const model = new MockLanguageModelV3({
      doStream: async (request) => {
        const last = request.prompt.at(-1);
        if (last?.role === 'user' && last.content.some((part) => part.type === 'text' && part.text === COMPACTION_PROMPT)) {
          summaryCalls++;
          return summaryCalls === 1
            ? fixtureText('Incomplete checkpoint.', 'length')
            : fixtureText('Complete retry checkpoint of the original task and tool evidence.');
        }
        normalCalls++;
        return normalCalls === 1
          ? delayedStream(
              [{ type: 'tool-call', toolCallId: 'completed-before-failure', toolName: 'inspect', input: '{}' }],
              'tool-calls',
              90_000,
            )
          : fixtureText('The task can continue.', 'stop', 20_000);
      },
    });
    const registry = new ToolRegistry();
    registry.register({
      providerId: 'host',
      name: 'inspect',
      description: 'A local fixture tool',
      inputSchema: { type: 'object', properties: {} },
      effect: { change: 'none', data: 'local', network: 'none', reversible: 'full', outbound: 'model' },
      autoApprove: () => true,
      execute: async () => ({ evidence: 'Original completed evidence. '.repeat(800) }),
    });
    const runtime = runtimeFor(model, registry);
    runtime.contextWindowTokens = 100_000;
    runtime.outputLimitTokens = 20_000;
    session = new AgentSessionController(runtime);
    session.openSession({
      ...createSession('fixture', 'fixture'),
      entries: [{ kind: 'user', text: 'Keep the original task.' }],
      conversation: [{ role: 'user', content: 'Keep the original task.' }],
    });
    const id = session.getSnapshot().session.id;
    await session.sendMessage({ text: 'Inspect the evidence.', images: [] }, preferences);
    session.flushSave();
    expect(normalCalls).toBe(1);
    expect(summaryCalls).toBe(1);
    expect(session.getLastRunError()).toMatch(/Compaction failed:.*cut off/);
    expect(session.isBusy).toBe(false);
    const failed = loadSavedSession(id)!;
    expect(JSON.stringify(failed.conversation)).toContain('completed-before-failure');
    expect(JSON.stringify(failed.conversation)).toContain('Original completed evidence.');
    expect(JSON.stringify(failed.conversation)).not.toContain('Incomplete checkpoint.');
    expect(failed.conversationArchive).toBeUndefined();
    await session.sendMessage({ text: 'Retry compaction and continue.', images: [] }, preferences);
    expect(summaryCalls).toBe(2);
    expect(normalCalls).toBe(2);
    expect(session.getLastRunError()).toBeNull();
  });

  it('shows compaction text and reasoning while streaming and commits the checkpoint only after completion', async () => {
    const { AgentSessionController } = await import('../src/agent-session.js');
    const { createSession, loadSavedSession } = await import('../src/session-store.js');
    let finish!: () => void;
    const finishing = new Promise<void>((resolveFinish) => {
      finish = resolveFinish;
    });
    const model = new MockLanguageModelV3({
      doStream: async () => ({
        stream: new ReadableStream({
          async start(controller) {
            controller.enqueue({ type: 'stream-start', warnings: [] });
            controller.enqueue({ type: 'reasoning-start', id: 'summary-reasoning' });
            controller.enqueue({ type: 'reasoning-delta', id: 'summary-reasoning', delta: 'Preserving the current task.' });
            controller.enqueue({ type: 'reasoning-end', id: 'summary-reasoning' });
            controller.enqueue({ type: 'text-start', id: 'summary-text' });
            controller.enqueue({ type: 'text-delta', id: 'summary-text', delta: 'Summary in progress.' });
            await finishing;
            controller.enqueue({ type: 'text-delta', id: 'summary-text', delta: ' The checkpoint is complete.' });
            controller.enqueue({ type: 'text-end', id: 'summary-text' });
            controller.enqueue({ type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage });
            controller.close();
          },
        }),
      }),
    });
    const raw: ModelMessage[] = [
      { role: 'user', content: 'Preserve the active task.' },
      { role: 'assistant', content: 'Work is in progress.' },
    ];
    const source = structuredClone(raw);
    session = new AgentSessionController(runtimeFor(model));
    session.openSession({
      ...createSession('fixture', 'fixture'),
      entries: [{ kind: 'user', text: 'Preserve the active task.' }],
      conversation: raw,
    });
    const id = session.getSnapshot().session.id;
    const pending = session.compact(preferences);
    try {
      await vi.waitFor(
        () => {
          const snapshot = session!.getSnapshot();
          expect(snapshot.busy).toBe(true);
          expect(snapshot.streamingAssistantEntry).toEqual({ kind: 'assistant', text: 'Summary in progress.' });
          expect(snapshot.session.entries).toContainEqual({ kind: 'reasoning', text: 'Preserving the current task.' });
        },
        { timeout: 1_000, interval: 25 },
      );
      session.flushSave();
      expect(loadSavedSession(id)!.conversation).toEqual(source);
      expect(loadSavedSession(id)!.conversationArchive).toBeUndefined();
    } finally {
      finish();
      await pending;
    }
    session.flushSave();
    const saved = loadSavedSession(id)!;
    expect(saved.conversationArchive).toEqual(source);
    expect(JSON.stringify(saved.conversation)).toContain('Summary in progress. The checkpoint is complete.');
    expect(saved.entries).toContainEqual({ kind: 'assistant', text: 'Summary in progress. The checkpoint is complete.' });
    expect(session.getSnapshot().streamingAssistantEntry).toBeNull();
    expect(model.doStreamCalls).toHaveLength(1);
  });

  it.each(['manual', 'automatic'] as const)('preserves the selected provider settings during %s compaction', async (mode) => {
    const { AgentSessionController } = await import('../src/agent-session.js');
    const { createSession } = await import('../src/session-store.js');
    const { estimateContextTokens } = await import('../src/compaction.js');
    const { getAgentContext } = await import('../src/agent.js');
    const raw: ModelMessage[] = [
      { role: 'user', content: 'Continue the implementation.' },
      {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'Historical evidence '.repeat(3_000) },
          { type: 'text', text: 'Work is in progress.' },
        ],
      },
    ];
    const model = new MockLanguageModelV3({
      doStream: [fixtureText('Detailed checkpoint of the implementation.'), fixtureText('Continuing the task.')],
    });
    const providerOptions = { fixture: { reasoningEffort: 'xhigh', cache_salt: 'conversation-cache' } };
    const runtime = runtimeFor(model);
    runtime.contextWindowTokens = 100_000;
    runtime.outputLimitTokens = 32_768;
    runtime.getReasoningProviderOptions = vi.fn(() => providerOptions);
    session = new AgentSessionController(runtime);
    session.openSession({
      ...createSession('fixture', 'fixture'),
      entries: [{ kind: 'user', text: 'Continue the implementation.' }],
      conversation: raw,
      contextTokens: 90_000,
      contextEstimateTokens: estimateContextTokens(getAgentContext(raw)),
    });
    const selected = { reasoningVariantId: 'xhigh', showReasoning: true };
    if (mode === 'manual') await session.compact(selected);
    else await session.sendMessage({ text: 'Continue.', images: [] }, selected);
    expect(model.doStreamCalls).toHaveLength(mode === 'manual' ? 1 : 2);
    for (const request of model.doStreamCalls) expect(request.providerOptions).toEqual(providerOptions);
    // Manual compaction honors its explicit argument; a running turn follows the
    // live runtime preference instead of its send-time capture, so a mid-run
    // settings change applies immediately.
    expect(runtime.getReasoningProviderOptions).toHaveBeenCalledWith(mode === 'manual' ? 'xhigh' : 'default', true);
  });

  it('retains measured context when selecting the same model on another provider, then compacts before continuing', async () => {
    const { AgentSessionController } = await import('../src/agent-session.js');
    const { createSession } = await import('../src/session-store.js');
    const { estimateContextTokens, COMPACTION_PROMPT } = await import('../src/compaction.js');
    const { getAgentContext } = await import('../src/agent.js');
    const raw: ModelMessage[] = [
      { role: 'user', content: 'Continue this task.' },
      {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'Current evidence '.repeat(4_000) },
          { type: 'text', text: 'Work is in progress.' },
        ],
      },
    ];
    const model = new MockLanguageModelV3({ doStream: [fixtureText('Complete checkpoint.'), fixtureText('Continuing the task.')] });
    const runtime = runtimeFor(model);
    runtime.contextWindowTokens = 262_144;
    runtime.outputLimitTokens = 32_768;
    runtime.selectModel = async (providerId, modelId) => {
      runtime.providerId = providerId;
      runtime.modelId = modelId;
    };
    session = new AgentSessionController(runtime);
    const estimate = estimateContextTokens(getAgentContext(raw));
    session.openSession({
      ...createSession('fixture', 'fixture'),
      entries: [{ kind: 'user', text: 'Continue this task.' }],
      conversation: raw,
      contextTokens: 239_000,
      contextEstimateTokens: estimate,
      contextGrowthTokens: 0,
    });
    await session.selectModel('another-endpoint', 'fixture');
    expect(session.getSnapshot().session.contextTokens).toBe(239_000);
    session.flushSave();
    const { loadSavedSession } = await import('../src/session-store.js');
    expect(loadSavedSession(session.getSnapshot().session.id)!.conversation).toEqual(raw);
    await session.sendMessage({ text: 'Continue.', images: [] }, preferences);
    expect(model.doStreamCalls).toHaveLength(2);
    expect(model.doStreamCalls[0]!.prompt.at(-1)).toEqual({ role: 'user', content: [{ type: 'text', text: COMPACTION_PROMPT }] });
    expect(model.doStreamCalls[1]!.prompt.at(-1)).not.toEqual(model.doStreamCalls[0]!.prompt.at(-1));
  });

  it('commits explicitly requested recovery only after the summary completes and keeps the complete original archive', async () => {
    const { AgentSessionController } = await import('../src/agent-session.js');
    const { createSession, loadSavedSession } = await import('../src/session-store.js');
    const { estimateContextTokens } = await import('../src/compaction.js');
    const { getAgentContext } = await import('../src/agent.js');
    const raw: ModelMessage[] = [
      { role: 'user', content: 'Preserve the complete user message.' },
      {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'Historical reasoning '.repeat(8_000) },
          { type: 'text', text: 'Preserve this response.' },
        ],
      },
      {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'Most recent reasoning.' },
          { type: 'text', text: 'Current progress.' },
        ],
      },
    ];
    const model = new MockLanguageModelV3({ doStream: async () => fixtureText('Complete recovered checkpoint.') });
    const runtime = runtimeFor(model);
    runtime.contextWindowTokens = 262_144;
    runtime.outputLimitTokens = 32_768;
    const options = { fixture: { reasoningEffort: 'xhigh' } };
    runtime.getReasoningProviderOptions = () => options;
    session = new AgentSessionController(runtime);
    session.openSession({
      ...createSession('fixture', 'fixture'),
      entries: [{ kind: 'user', text: 'Preserve the complete user message.' }],
      conversation: raw,
      contextTokens: 258_950,
      contextEstimateTokens: estimateContextTokens(getAgentContext(raw)),
    });
    await session.compact({ reasoningVariantId: 'xhigh', showReasoning: true }, true);
    session.flushSave();
    const saved = loadSavedSession(session.getSnapshot().session.id)!;
    expect(model.doStreamCalls).toHaveLength(1);
    expect(model.doStreamCalls[0]!.providerOptions).toEqual(options);
    expect(saved.conversationArchive).toEqual(raw);
    expect(saved.conversation).toContainEqual(raw[0]);
    expect(JSON.stringify(saved.conversation)).toContain('Preserve this response.');
    expect(JSON.stringify(saved.conversation)).toContain('Complete recovered checkpoint.');
    expect(saved.contextTokens).toBeUndefined();
    expect(saved.entries.some((entry) => entry.kind === 'notice' && entry.text.includes('Recovering compaction:'))).toBe(true);
  });

  it('preserves the raw archive and visible dialogue across repeated compaction, while persisting provider usage', async () => {
    const { AgentSessionController } = await import('../src/agent-session.js');
    const { createSession, loadSavedSession } = await import('../src/session-store.js');
    const reasoning = 'Old internal reasoning '.repeat(3_000);
    const raw: ModelMessage[] = [
      { role: 'user', content: 'Implement the runtime; do not restart services.' },
      {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: reasoning },
          { type: 'text', text: 'Inspecting src/runtime.ts.' },
          { type: 'tool-call', toolCallId: 'original-call', toolName: 'file_read', input: { path: 'src/runtime.ts' } },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'original-call',
            toolName: 'file_read',
            output: { type: 'text', value: 'Original file data '.repeat(3_000) },
          },
        ],
      },
    ];
    const source = structuredClone(raw);
    const model = new MockLanguageModelV3({
      doStream: [
        fixtureText('src/runtime.ts owns the runtime. Implementation remains unfinished. Do not restart services.'),
        fixtureText('Continuing the implementation.'),
        fixtureText('Merged checkpoint with the original constraints and current progress.'),
      ],
    });
    session = new AgentSessionController(runtimeFor(model));
    session.openSession({
      ...createSession('fixture', 'fixture'),
      title: 'Existing task',
      entries: [{ kind: 'user', text: 'Implement the runtime; do not restart services.' }],
      conversation: raw,
    });
    const id = session.getSnapshot().session.id;
    await session.compact(preferences);
    session.flushSave();
    const checkpoint = loadSavedSession(id)!;
    expect(checkpoint.conversationArchive).toEqual(source);
    expect(checkpoint.conversation).toContainEqual(raw[0]);
    expect(checkpoint.conversation).toContainEqual({ role: 'assistant', content: [{ type: 'text', text: 'Inspecting src/runtime.ts.' }] });
    expect(JSON.stringify(checkpoint.conversation)).not.toContain(reasoning);

    await session.sendMessage({ text: 'Continue safely.', images: [] }, preferences);
    session.flushSave();
    const resumed = loadSavedSession(id)!;
    expect(resumed.contextTokens).toBe(100);
    expect(resumed.contextEstimateTokens).toBeGreaterThan(0);
    expect(resumed.conversationArchive!.slice(0, 3)).toEqual(source);
    expect(resumed.conversationArchive).toHaveLength(5);
    await session.compact(preferences);
    session.flushSave();
    const repeated = loadSavedSession(id)!;
    expect(repeated.conversationArchive).toEqual(resumed.conversationArchive);
    expect(JSON.stringify(model.doStreamCalls[2]!.prompt)).not.toContain(reasoning);
    expect(JSON.stringify(model.doStreamCalls[2]!.prompt)).toContain('Do not restart services.');
    const continuation = resumed.conversation.find(
      (message) =>
        message.role === 'user' &&
        Array.isArray(message.content) &&
        message.content.some((part) => part.type === 'text' && part.text === 'Continue safely.'),
    )!;
    expect(continuation).toBeDefined();
    expect(repeated.conversation.filter((message) => JSON.stringify(message) === JSON.stringify(continuation))).toHaveLength(1);
    expect(repeated.contextTokens).toBeUndefined();
    expect(repeated.contextEstimateTokens).toBeUndefined();
    expect(raw).toEqual(source);
    expect(model.doStreamCalls).toHaveLength(3);
  });

  it('keeps a failed checkpoint out of both the active prompt and saved archive', async () => {
    const { AgentSessionController } = await import('../src/agent-session.js');
    const { createSession, loadSavedSession } = await import('../src/session-store.js');
    const raw: ModelMessage[] = [
      { role: 'user', content: 'The unfinished original request.' },
      { role: 'assistant', content: 'Original progress.' },
    ];
    const source = structuredClone(raw);
    const model = new MockLanguageModelV3({
      doStream: [fixtureText('Incomplete checkpoint must not be committed.', 'length'), fixtureText('Continuing the original request.')],
    });
    session = new AgentSessionController(runtimeFor(model));
    session.openSession({
      ...createSession('fixture', 'fixture'),
      title: 'Existing task',
      entries: [{ kind: 'user', text: 'The unfinished original request.' }],
      conversation: raw,
      contextTokens: 90_000,
    });
    const id = session.getSnapshot().session.id;
    await session.compact(preferences);
    session.flushSave();
    const saved = loadSavedSession(id)!;
    expect(saved.conversation).toEqual(source);
    expect(saved.conversationArchive).toBeUndefined();
    expect(saved.contextTokens).toBe(90_000);
    expect(saved.entries).toContainEqual({ kind: 'assistant', text: 'Incomplete checkpoint must not be committed.' });
    expect(saved.entries.some((entry) => entry.kind === 'notice' && entry.text.includes('Compaction failed:'))).toBe(true);
    await session.sendMessage({ text: 'Continue.', images: [] }, preferences);
    const resumedPrompt = JSON.stringify(model.doStreamCalls[1]!.prompt);
    expect(resumedPrompt).toContain('The unfinished original request.');
    expect(resumedPrompt).not.toContain('Incomplete checkpoint');
    expect(resumedPrompt).not.toContain('Continue the unfinished user request from the compacted history');
    expect(model.doStreamCalls).toHaveLength(2);
  });
});

describe('session questions', () => {
  function questionCall(input: string) {
    return delayedStream([{ type: 'tool-call', toolCallId: 'ask-1', toolName: 'question', input }], 'tool-calls');
  }

  it('surfaces the pending question, delivers the answer, and clears it from the snapshot', async () => {
    const registry = new ToolRegistry();
    const { createQuestionTool } = await import('../src/tools/question.js');
    registry.register(createQuestionTool());
    const model = new MockLanguageModelV3({
      doGenerate: async () => titleResponse(),
      doStream: vi
        .fn()
        .mockImplementationOnce(async () => questionCall('{"question":"Which environment?","options":["Staging","Production"]}'))
        .mockImplementationOnce(async () => fixtureText('Deploying to Staging.')),
    });
    const { AgentSessionController } = await import('../src/agent-session.js');
    session = new AgentSessionController(runtimeFor(model, registry));
    const run = session.sendMessage({ text: 'deploy', images: [] }, preferences);

    await vi.waitFor(() => {
      expect(session!.getSnapshot().pendingQuestion).not.toBeNull();
    });
    const pending = session.getSnapshot().pendingQuestion!;
    expect(pending.question).toBe('Which environment?');
    expect(pending.options).toEqual(['Staging', 'Production']);
    expect(session.getSnapshot().busy).toBe(true);

    session.answerQuestion('Staging', pending.id);
    await run;

    const snapshot = session.getSnapshot();
    expect(snapshot.pendingQuestion).toBeNull();
    const tool = snapshot.session.entries.find((entry) => entry.kind === 'tool') as { result: string } | undefined;
    expect(tool?.result).toBe('Staging');
    expect(snapshot.session.entries.at(-1)).toEqual({ kind: 'assistant', text: 'Deploying to Staging.' });
  });

  it('resolves a dismissed question to null on stop', async () => {
    const registry = new ToolRegistry();
    const { createQuestionTool } = await import('../src/tools/question.js');
    registry.register(createQuestionTool());
    const model = new MockLanguageModelV3({
      doGenerate: async () => titleResponse(),
      doStream: vi.fn().mockImplementationOnce(async () => questionCall('{"question":"Proceed?"}')),
    });
    const { AgentSessionController } = await import('../src/agent-session.js');
    session = new AgentSessionController(runtimeFor(model, registry));
    const run = session.sendMessage({ text: 'go', images: [] }, preferences);

    await vi.waitFor(() => {
      expect(session!.getSnapshot().pendingQuestion).not.toBeNull();
    });
    session.stop();
    await run;

    const snapshot = session.getSnapshot();
    expect(snapshot.pendingQuestion).toBeNull();
    expect(snapshot.busy).toBe(false);
  });

  it('reports the question as unavailable in a background session instead of waiting', async () => {
    const registry = new ToolRegistry();
    const { createQuestionTool } = await import('../src/tools/question.js');
    registry.register(createQuestionTool());
    const model = new MockLanguageModelV3({
      doGenerate: async () => titleResponse(),
      doStream: vi
        .fn()
        .mockImplementationOnce(async () => questionCall('{"question":"Which environment?"}'))
        .mockImplementationOnce(async () => fixtureText('Included the question in the final answer.')),
    });
    const { AgentSessionController } = await import('../src/agent-session.js');
    session = new AgentSessionController(runtimeFor(model, registry), undefined, {
      background: true,
      autoApprove: () => true,
    });
    await session.sendMessage({ text: 'deploy', images: [] }, preferences);

    const snapshot = session.getSnapshot();
    expect(snapshot.pendingQuestion).toBeNull();
    const tool = snapshot.session.entries.find((entry) => entry.kind === 'tool') as { result: string } | undefined;
    expect(tool?.result).toContain('No interactive user is attached');
    expect(snapshot.session.entries.at(-1)).toEqual({ kind: 'assistant', text: 'Included the question in the final answer.' });
  });
});

describe('session activity reporting', () => {
  it('reports the session running for the whole turn and clears it afterwards', async () => {
    const { AgentSessionController } = await import('../src/agent-session.js');
    const { isSessionActive, resetSessionActivityForTests } = await import('../src/session-registry.js');
    const { createSession, saveSession } = await import('../src/session-store.js');
    resetSessionActivityForTests();
    saveSession({
      ...createSession('fixture', 'fixture', undefined, process.cwd()),
      entries: [{ kind: 'user', text: 'sibling work' }],
    });

    let captured: unknown;
    const model = new MockLanguageModelV3({
      doGenerate: async () => titleResponse(),
      doStream: async (options) => {
        captured = options;
        return delayedStream([
          { type: 'text-start', id: 'activity' },
          { pause: 50 },
          { type: 'text-delta', id: 'activity', delta: 'Working.' },
          { type: 'text-end', id: 'activity' },
        ]);
      },
    });
    session = new AgentSessionController(runtimeFor(model));
    const id = session.getSnapshot().session.id;

    const run = session.sendMessage({ text: 'Do the work.', images: [] }, preferences);
    expect(isSessionActive(id)).toBe(true);
    await run;
    expect(isSessionActive(id)).toBe(false);

    // The system prompt carries no live session list, so it stays cacheable.
    const prompt = JSON.stringify(captured);
    expect(prompt).not.toContain('## Recent sessions');
    expect(prompt).not.toContain('sibling work');
  });

  it('keeps queued messages on a keepQueue stop and drops them on a plain stop', async () => {
    const { AgentSessionController } = await import('../src/agent-session.js');
    const endless = () => {
      let timer: NodeJS.Timeout | undefined;
      return {
        stream: new ReadableStream<LanguageModelV3StreamPart>({
          start(controller) {
            controller.enqueue({ type: 'stream-start', warnings: [] });
            controller.enqueue({ type: 'text-start', id: 'endless' });
            controller.enqueue({ type: 'text-delta', id: 'endless', delta: 'Still working…' });
            timer = setInterval(() => {
              try {
                controller.enqueue({ type: 'text-delta', id: 'endless', delta: '.' });
              } catch {
                if (timer) clearInterval(timer);
              }
            }, 25);
          },
          cancel() {
            if (timer) clearInterval(timer);
          },
        }),
      };
    };
    const model = new MockLanguageModelV3({
      doGenerate: async () => titleResponse(),
      doStream: vi
        .fn()
        .mockImplementationOnce(async () => endless())
        .mockImplementationOnce(async () =>
          delayedStream([
            { type: 'text-start', id: 'third' },
            { type: 'text-delta', id: 'third', delta: 'Third answer.' },
            { type: 'text-end', id: 'third' },
          ]),
        ),
    });
    session = new AgentSessionController(runtimeFor(model));
    void session.sendMessage({ text: 'First request.', images: [] }, preferences);
    // Wait until the stream is actually flowing so the queued message cannot be drained mid-run.
    await vi.waitFor(() =>
      expect(
        session!.getSnapshot().session.entries.some((entry) => entry.kind === 'assistant' && entry.text.includes('Still working')),
      ).toBe(true),
    );
    void session.sendMessage({ text: 'Second request.', images: [] }, preferences);
    await vi.waitFor(() => expect(session!.getSnapshot().queuedMessageCount).toBe(1));

    session.stop({ keepQueue: true });
    // The aborted run ends and the preserved input starts automatically in a fresh turn.
    await vi.waitFor(() => expect(session!.getSnapshot().busy).toBe(false));
    expect(session.getSnapshot().queuedMessageCount).toBe(0);
    void session.sendMessage({ text: 'Third request.', images: [] }, preferences);
    await vi.waitFor(() =>
      expect(session!.getSnapshot().session.entries.some((entry) => entry.kind === 'user' && entry.text === 'Second request.')).toBe(true),
    );
    expect(session.getSnapshot().queuedMessageCount).toBe(0);
    await session.close();
    session = undefined;

    const plainModel = new MockLanguageModelV3({
      doGenerate: async () => titleResponse(),
      doStream: vi
        .fn()
        .mockImplementationOnce(async () => endless())
        .mockImplementationOnce(async () =>
          delayedStream([
            { type: 'text-start', id: 'unused' },
            { type: 'text-delta', id: 'unused', delta: 'Should never run.' },
            { type: 'text-end', id: 'unused' },
          ]),
        ),
    });
    session = new AgentSessionController(runtimeFor(plainModel));
    void session.sendMessage({ text: 'First request.', images: [] }, preferences);
    await vi.waitFor(() =>
      expect(
        session!.getSnapshot().session.entries.some((entry) => entry.kind === 'assistant' && entry.text.includes('Still working')),
      ).toBe(true),
    );
    void session.sendMessage({ text: 'Second request.', images: [] }, preferences).catch(() => {});
    await vi.waitFor(() => expect(session!.getSnapshot().queuedMessageCount).toBe(1));

    session.stop();
    await vi.waitFor(() => expect(session!.getSnapshot().busy).toBe(false));
    expect(session.getSnapshot().queuedMessageCount).toBe(0);
    expect(session.getSnapshot().session.entries.some((entry) => entry.kind === 'user' && entry.text === 'Second request.')).toBe(false);
  });

  it('holds queued messages on a holdQueue stop: they stay visible without starting a run', async () => {
    const { AgentSessionController } = await import('../src/agent-session.js');
    let calls = 0;
    const endless = () => {
      let timer: NodeJS.Timeout | undefined;
      return {
        stream: new ReadableStream<LanguageModelV3StreamPart>({
          start(controller) {
            controller.enqueue({ type: 'stream-start', warnings: [] });
            controller.enqueue({ type: 'text-start', id: 'endless' });
            controller.enqueue({ type: 'text-delta', id: 'endless', delta: 'Still working…' });
            timer = setInterval(() => {
              try {
                controller.enqueue({ type: 'text-delta', id: 'endless', delta: '.' });
              } catch {
                if (timer) clearInterval(timer);
              }
            }, 25);
          },
          cancel() {
            if (timer) clearInterval(timer);
          },
        }),
      };
    };
    const answer = (id: string, text: string) => async () => {
      calls++;
      if (calls === 1) return endless();
      return delayedStream([
        { type: 'text-start', id },
        { type: 'text-delta', id, delta: text },
        { type: 'text-end', id },
      ]);
    };
    const model = new MockLanguageModelV3({
      doGenerate: async () => titleResponse(),
      doStream: vi.fn().mockImplementation(async () => answer(`answer-${calls + 1}`, `Answer ${calls + 1}.`)()),
    });
    session = new AgentSessionController(runtimeFor(model));
    void session.sendMessage({ text: 'First request.', images: [] }, preferences);
    await vi.waitFor(() =>
      expect(
        session!.getSnapshot().session.entries.some((entry) => entry.kind === 'assistant' && entry.text.includes('Still working')),
      ).toBe(true),
    );
    void session.sendMessage({ text: 'Second request.', images: [] }, preferences);
    await vi.waitFor(() => expect(session!.getSnapshot().queuedMessageCount).toBe(1));

    session.stop({ keepQueue: true, holdQueue: true });
    await vi.waitFor(() => expect(session!.getSnapshot().busy).toBe(false));
    // The Esc contract: the queue survives visibly in the chat, but nothing restarts on its own.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(calls).toBe(1);
    expect(session.getSnapshot().queuedMessageCount).toBe(1);

    // The next explicit send releases the hold: held and new messages run together.
    void session.sendMessage({ text: 'Third request.', images: [] }, preferences);
    await vi.waitFor(() =>
      expect(session!.getSnapshot().session.entries.some((entry) => entry.kind === 'user' && entry.text === 'Second request.')).toBe(true),
    );
    await vi.waitFor(() =>
      expect(session!.getSnapshot().session.entries.some((entry) => entry.kind === 'user' && entry.text === 'Third request.')).toBe(true),
    );
    await vi.waitFor(() => expect(session!.getSnapshot().queuedMessageCount).toBe(0));
    await session.close();
    session = undefined;
  });
});
