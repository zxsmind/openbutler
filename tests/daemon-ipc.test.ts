import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { MockLanguageModelV3 } from 'ai/test';
import { pathToFileURL } from 'node:url';
import type { LanguageModelV3StreamPart } from '@ai-sdk/provider';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEnvironment, AgentSessionClient } from '../src/agent-session.js';
import type { DaemonHost } from '../src/daemon-host.js';
import { ToolRegistry } from '../src/tools/registry.js';

const daemonStart = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock('../src/daemon.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/daemon.js')>();
  return { ...actual, startDaemon: daemonStart.run };
});

const usage = {
  inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 20, text: 20, reasoning: 0 },
};
const preferences = { reasoningVariantId: 'auto', showReasoning: false };
let root: string;
let host: DaemonHost;
let server: Server;
let clients: AgentSessionClient[];
let connect: (typeof import('../src/daemon-client.js'))['connectDaemonSession'];
let requestHost: (typeof import('../src/daemon.js'))['requestHost'];
let model: MockLanguageModelV3;
let registry: ToolRegistry;
const registrySeen = new WeakSet<ToolRegistry>();
const sessionMessageSeen = new WeakSet<ToolRegistry>();
const subagentSeen = new WeakSet<ToolRegistry>();
const parentMessageSeen = new WeakSet<ToolRegistry>();
const subagentPollSeen = new WeakSet<ToolRegistry>();
const subagentStopSeen = new WeakSet<ToolRegistry>();
const ownerNotifySeen = new WeakSet<ToolRegistry>();

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
/** A worker stream that keeps its run alive until the run is stopped. */
function holdOpenWorkerStream(signal?: AbortSignal | null) {
  return {
    stream: new ReadableStream<LanguageModelV3StreamPart>({
      start(controller) {
        controller.enqueue({ type: 'stream-start', warnings: [] });
        controller.enqueue({ type: 'text-start', id: 'work' });
        controller.enqueue({ type: 'text-delta', id: 'work', delta: 'Working…' });
        const finish = () => {
          try {
            controller.enqueue({ type: 'text-end', id: 'work' });
            controller.enqueue({ type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage });
            controller.close();
          } catch {
            /* already closed */
          }
        };
        if (signal?.aborted) finish();
        else signal?.addEventListener('abort', finish, { once: true });
      },
    }),
  };
}

async function createFixtureHost(): Promise<DaemonHost> {
  const { createDaemonHost } = await import('../src/daemon-host.js');
  return createDaemonHost({
    startedAt: new Date().toISOString(),
    requestStop: () => {},
    log: () => {},
    runtimeFactory: async (options) => {
      const backgroundManage = options?.backgroundManage;
      if (options?.ownerNotify && !ownerNotifySeen.has(registry)) {
        const { createNotifyOwnerTool } = await import('../src/tools/notify-owner.js');
        registry.register(createNotifyOwnerTool(options.workspaceRoot ?? process.cwd(), options.ownerNotify));
        ownerNotifySeen.add(registry);
      }
      const sessionMessage = options?.sessionMessage;
      const subagent = options?.subagent;
      const parentMessage = options?.parentMessage;
      const subagentPoll = options?.subagentPoll;
      const subagentStop = options?.subagentStop;
      const workspaceRoot = options?.workspaceRoot ?? process.cwd();
      const { createBackgroundManagementTool } = await import('../src/tools/background.js');
      if (backgroundManage && !registrySeen.has(registry)) {
        registry.register(createBackgroundManagementTool(workspaceRoot, backgroundManage));
        registrySeen.add(registry);
      }
      if (sessionMessage && !sessionMessageSeen.has(registry)) {
        const { createSessionMessageTool } = await import('../src/tools/session-message.js');
        registry.register(createSessionMessageTool(sessionMessage));
        sessionMessageSeen.add(registry);
      }
      if (subagent && !subagentSeen.has(registry)) {
        const { createSubagentTool } = await import('../src/tools/subagent.js');
        registry.register(createSubagentTool(subagent));
        subagentSeen.add(registry);
      }
      if (parentMessage && !parentMessageSeen.has(registry)) {
        const { createParentMessageTool } = await import('../src/tools/parent-message.js');
        registry.register(createParentMessageTool(parentMessage));
        parentMessageSeen.add(registry);
      }
      if (subagentPoll && !subagentPollSeen.has(registry)) {
        const { createSubagentPollTool } = await import('../src/tools/subagent-poll.js');
        registry.register(createSubagentPollTool(subagentPoll));
        subagentPollSeen.add(registry);
      }
      if (subagentStop && !subagentStopSeen.has(registry)) {
        const { createSubagentStopTool } = await import('../src/tools/subagent-stop.js');
        registry.register(createSubagentStopTool(subagentStop));
        subagentStopSeen.add(registry);
      }
      const runtime: AgentEnvironment = {
        model,
        workspaceRoot,
        modelName: 'Local fixture',
        providerId: 'fixture',
        modelId: 'fixture',
        contextWindowTokens: null,
        outputLimitTokens: null,
        supportsVision: false,
        supportsImageToolResult: true,
        reasoningVariants: [],
        reasoningMetadataSource: null,
        reasoningDefault: 'auto',
        showReasoningDefault: false,
        saveReasoningPreference: () => {},
        saveShowReasoningPreference: () => {},
        getReasoningProviderOptions: () => ({}),
        registry,
        selectModel: async () => {},
        close: async () => {},
      };
      return runtime;
    },
  });
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'ranite-ipc-check-'));
  vi.stubEnv('RANITE_DATA_DIR', root);
  vi.resetModules();
  clients = [];
  daemonStart.run.mockReset();
  registry = new ToolRegistry();
  model = new MockLanguageModelV3({
    doGenerate: async () => ({
      content: [{ type: 'text', text: '{"title":"Fixture session"}' }],
      finishReason: { unified: 'stop', raw: 'stop' },
      usage,
      warnings: [],
    }),
    doStream: async () => textStream('Fixture response'),
  });
  const daemon = await import('../src/daemon.js');
  requestHost = daemon.requestHost;
  connect = (await import('../src/daemon-client.js')).connectDaemonSession;
  host = await createFixtureHost();
  server = createServer((socket) => host.handleConnection(socket));
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(daemon.getDaemonEndpoint(), () => resolveListen());
  });
  await host.start();
});
afterEach(async () => {
  await Promise.all(clients.map((client) => client.close()));
  await host.close();
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  vi.unstubAllEnvs();
  if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith('ranite-ipc-check-'))
    throw new Error('Unsafe fixture cleanup path.');
  rmSync(root, { recursive: true, force: true });
});
async function client(options: { isolatedSession?: boolean; taskId?: string; workerSessionId?: string; runningWorkerOf?: string } = {}) {
  const result = await connect(root, async () => false, options);
  clients.push(result);
  return result;
}

function registerFakeTool(name: string): void {
  registry.register({
    providerId: 'fixture',
    name,
    description: `Fixture tool ${name}.`,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    effect: { change: 'none', data: 'public', network: 'none', reversible: 'full', outbound: 'none' },
    execute: async () => ({ status: 'ok' }),
  });
}

function offeredToolNames(options: { tools?: unknown }): string[] {
  return (Array.isArray(options.tools) ? options.tools : []).map((tool) => {
    const name = (tool as { name?: string }).name ?? '';
    return name.startsWith('fixture__') ? name.slice('fixture__'.length) : name;
  });
}

async function replaceFixtureHost() {
  await host.close();
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  host = await createFixtureHost();
  server = createServer((socket) => host.handleConnection(socket));
  const daemon = await import('../src/daemon.js');
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(daemon.getDaemonEndpoint(), () => resolveListen());
  });
  await host.start();
}

describe('shared host and session IPC', () => {
  it('delivers ordered assistant replies only to their source and resumes failed chunks without replaying confirmed ones', async () => {
    const settings = await import('../src/settings.js');
    const store = settings.defaultSettings();
    store.telegram = { enabled: true, tokenEnv: 'FTG_REPLY_TOKEN', workspaceRoot: root, chatId: '42', userId: '7' };
    settings.saveSettings(store);
    vi.stubEnv('FTG_REPLY_TOKEN', '123456:fixture-reply-token-value-ok');
    const { ActivityLedger } = await import('../src/activity-ledger.js');
    const fixtureLedger = new ActivityLedger(join(root, 'state.db'));
    fixtureLedger.setState('telegram:routed-to-custodian', 'sent');
    fixtureLedger.close();
    const sent: string[] = [];
    let attempts = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: unknown, init?: RequestInit) => {
        const method = String(url).split('/').at(-1);
        const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
        let result: unknown = true;
        if (method === 'getMe') result = { is_bot: true, username: 'reply_bot' };
        if (method === 'getWebhookInfo') result = {};
        if (method === 'getUpdates')
          result = await new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new Error('Fixture polling aborted.')), { once: true });
          });
        if (method === 'sendMessage') {
          attempts++;
          if (attempts === 2)
            return new Response(JSON.stringify({ ok: false, description: 'Fixture send failure', parameters: { retry_after: 1 } }), {
              status: 429,
            });
          expect(body.chat_id).toBe('42');
          sent.push(String(body.text));
          result = { message_id: attempts };
        }
        return new Response(JSON.stringify({ ok: true, result }));
      }),
    );
    try {
      await requestHost('settings.reload');
      const viewer = await client();
      registry.register({
        providerId: 'host',
        name: 'inspect',
        description: 'Fixture',
        inputSchema: { type: 'object', properties: {} },
        effect: { change: 'none', data: 'local', network: 'none', reversible: 'full', outbound: 'model' },
        autoApprove: () => true,
        execute: async () => ({ message: 'Private tool output' }),
      });
      const before = `Bakıyorum. ${'x'.repeat(4500)}\n`;
      const final = 'Uzun yanıtın ardından gelen son parça.';
      model.doStream = vi
        .fn()
        .mockImplementationOnce(async () =>
          stream(
            [
              { type: 'text-start', id: 'before' },
              { type: 'text-delta', id: 'before', delta: before },
              { type: 'text-end', id: 'before' },
              { type: 'tool-call', toolCallId: 'inspect', toolName: 'inspect', input: '{}' },
            ],
            'tool-calls',
          ),
        )
        .mockImplementationOnce(async () => textStream(final));
      await host.receiveTelegramMessage(1001, 'Inspect this');
      type Event = { id: string; source: string; status: string; payload: Record<string, unknown> };
      let notificationId = '';
      await vi.waitFor(
        async () => {
          const events = (await requestHost('ledger.events')) as Event[];
          const notification = events.find(
            (event) =>
              event.source === 'notification' &&
              Array.isArray(event.payload.messages) &&
              String(event.payload.messages[0]).startsWith('Bakıyorum.'),
          );
          expect(notification?.status).toBe('pending');
          notificationId = notification!.id;
        },
        { timeout: 6000 },
      );
      expect(sent).toHaveLength(1);
      model.doStream = vi.fn(async () => textStream('Second reply'));
      await host.receiveTelegramMessage(1002, 'Second request');
      await vi.waitFor(
        async () => {
          const events = (await requestHost('ledger.events')) as Event[];
          expect(events.filter((event) => event.source === 'notification' && event.status === 'pending')).toHaveLength(2);
        },
        { timeout: 6000 },
      );
      expect(sent).toHaveLength(1);
      await expect(requestHost('events.retry', { eventId: notificationId })).resolves.toEqual({ queued: true });
      await vi.waitFor(
        async () => {
          const events = (await requestHost('ledger.events')) as Event[];
          expect(events.filter((event) => event.source === 'notification' && event.status === 'delivered')).toHaveLength(2);
        },
        { timeout: 8000 },
      );
      expect(sent.join('')).toBe(before + final + 'Second reply');
      expect(sent.join('')).not.toContain('Private tool output');
      expect(sent.every((text) => text.length <= 4096)).toBe(true);
      expect(viewer.getSnapshot().session.entries.some((entry) => entry.kind === 'notice' && entry.text.includes('Bakıyorum.'))).toBe(
        false,
      );
      const ordinaryReplyCount = sent.length;
      await expect(
        requestHost('background.manage', { input: { action: 'notify', message: 'Terminal-only alert' }, workspaceRoot: root }),
      ).resolves.toMatchObject({ status: 'delivered', channel: 'terminal' });
      expect(sent).toHaveLength(ordinaryReplyCount);
      model.doStream = vi
        .fn()
        .mockImplementationOnce(async () =>
          stream(
            [
              {
                type: 'tool-call',
                toolCallId: 'notify',
                toolName: 'notify_owner',
                input: JSON.stringify({ channel: 'telegram', message: 'Proactive owner alert' }),
              },
            ],
            'tool-calls',
          ),
        )
        .mockImplementationOnce(async () => textStream('Notification sent.'));
      await viewer.sendMessage({ text: 'Send a separate owner alert', images: [] }, preferences);
      await vi.waitFor(
        () =>
          expect(
            viewer.getSnapshot().session.entries.some((entry) => entry.kind === 'assistant' && entry.text === 'Notification sent.'),
          ).toBe(true),
        { timeout: 5000 },
      );
      expect(sent.slice(ordinaryReplyCount)).toEqual(['Proactive owner alert']);
    } finally {
      vi.unstubAllGlobals();
    }
  }, 15_000);
  it('reconnects shared and isolated TUI sessions after an intentional restart', async () => {
    daemonStart.run.mockResolvedValue({ pid: 9001, startedAt: new Date().toISOString(), workspaceCount: 0, connectedClients: 0 });
    const shared = await client();
    const isolated = await client({ isolatedSession: true });
    const sharedId = shared.getSnapshot().session.id;
    const isolatedId = isolated.getSnapshot().session.id;
    for (const attached of [shared, isolated]) {
      await attached.sendMessage({ text: 'Preserve this session during restart.', images: [] }, preferences);
      await vi.waitFor(() =>
        expect(
          attached.getSnapshot().session.entries.some((entry) => entry.kind === 'assistant' && entry.text === 'Fixture response'),
        ).toBe(true),
      );
      await attached.flushSave();
    }
    await requestHost('stop', { restart: true });
    for (const attached of [shared, isolated])
      await vi.waitFor(() =>
        expect(
          attached.getSnapshot().session.entries.some((entry) => entry.kind === 'notice' && entry.text.includes('Ranite host restarting')),
        ).toBe(true),
      );
    await replaceFixtureHost();
    for (const attached of [shared, isolated])
      await vi.waitFor(
        () =>
          expect(
            attached
              .getSnapshot()
              .session.entries.some((entry) => entry.kind === 'notice' && entry.text.includes('Reconnected to the Ranite host.')),
          ).toBe(true),
        { timeout: 5_000, interval: 25 },
      );
    expect(shared.getSnapshot().session.id).toBe(sharedId);
    expect(isolated.getSnapshot().session.id).toBe(isolatedId);
    expect(shared.getSnapshot().session.entries).toContainEqual(
      expect.objectContaining({ kind: 'user', text: 'Preserve this session during restart.' }),
    );
    expect(isolated.getSnapshot().session.entries).toContainEqual({ kind: 'assistant', text: 'Fixture response' });
  }, 10_000);

  it('restores the selected workspace session after restart with no TUI connected', async () => {
    const attached = await client();
    const id = attached.getSnapshot().session.id;
    await attached.sendMessage({ text: 'Resume this workspace after restart.', images: [] }, preferences);
    await vi.waitFor(() =>
      expect(attached.getSnapshot().session.entries.some((entry) => entry.kind === 'assistant' && entry.text === 'Fixture response')).toBe(
        true,
      ),
    );
    await attached.flushSave();
    attached.close();
    await requestHost('stop', { restart: true });
    await replaceFixtureHost();
    const restored = await client();
    expect(restored.getSnapshot().session.id).toBe(id);
    expect(restored.getSnapshot().session.entries).toContainEqual(
      expect.objectContaining({ kind: 'user', text: 'Resume this workspace after restart.' }),
    );
  });

  it('keeps an explicit stop stopped instead of restarting it from an attached client', async () => {
    const attached = await client();
    await requestHost('stop');
    await vi.waitFor(() =>
      expect(
        attached.getSnapshot().session.entries.some((entry) => entry.kind === 'notice' && entry.text.includes('Ranite host stopping')),
      ).toBe(true),
    );
    await host.close();
    await vi.waitFor(() =>
      expect(
        attached.getSnapshot().session.entries.some((entry) => entry.kind === 'notice' && entry.text.includes('The Ranite host stopped.')),
      ).toBe(true),
    );
    expect(daemonStart.run).not.toHaveBeenCalled();
  });

  it('reattaches the existing client and restores its saved session after an unexpected host disconnect', async () => {
    daemonStart.run.mockResolvedValue({
      pid: 9001,
      startedAt: new Date().toISOString(),
      workspaceCount: 0,
      connectedClients: 0,
    });
    const attached = await client();
    const sessionId = attached.getSnapshot().session.id;
    await attached.sendMessage({ text: 'Persist this task before disconnect.', images: [] }, preferences);
    await vi.waitFor(
      () =>
        expect(
          attached.getSnapshot().session.entries.some((entry) => entry.kind === 'assistant' && entry.text === 'Fixture response'),
        ).toBe(true),
      { timeout: 5_000, interval: 25 },
    );
    await attached.flushSave();

    await replaceFixtureHost();

    await vi.waitFor(
      () =>
        expect(
          attached
            .getSnapshot()
            .session.entries.some((entry) => entry.kind === 'notice' && entry.text.includes('Reconnected to the Ranite host.')),
        ).toBe(true),
      { timeout: 5_000, interval: 25 },
    );
    expect(attached.getSnapshot().session.id).toBe(sessionId);
    expect(daemonStart.run).toHaveBeenCalledWith();
    expect(
      attached
        .getSnapshot()
        .session.entries.some((entry) => entry.kind === 'user' && entry.text === 'Persist this task before disconnect.'),
    ).toBe(true);
  }, 10_000);

  it('runs the real --c CLI entry through an isolated host session without contacting a model provider', async () => {
    const settings = await import('../src/settings.js');
    const store = settings.defaultSettings();
    store.providers.fixture = { enabled: true, keys: ['fixture-only-key'], npm: '@ai-sdk/openai-compatible', url: 'http://127.0.0.1:1/v1' };
    store.providerOrder = ['fixture'];
    store.defaultProvider = 'fixture';
    store.defaultModel = 'fixture';
    settings.saveSettings(store);
    const memory = await import('../src/memory-index.js');
    const modelRoot = join(root, 'models', memory.MEMORY_EMBEDDING_MODEL, memory.MEMORY_EMBEDDING_REVISION);
    mkdirSync(join(modelRoot, 'onnx'), { recursive: true });
    // The CLI checks cache metadata; inference is supplied only by this host's local model fixture.
    for (const file of ['config.json', 'tokenizer.json', 'tokenizer_config.json', 'onnx/model_quantized.onnx'])
      writeFileSync(join(modelRoot, file), 'fixture-only cache metadata');
    const shared = await client();
    const sharedId = shared.getSnapshot().session.id;
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolveChild, rejectChild) => {
      const loader = pathToFileURL(resolve('node_modules/tsx/dist/loader.mjs')).href;
      const child = spawn(process.execPath, ['--import', loader, resolve('src/cli.ts'), '--workspace', root, '--c', 'A fixture request'], {
        cwd: root,
        env: { ...process.env, RANITE_DATA_DIR: root },
        windowsHide: true,
      });
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => {
        child.kill();
        rejectChild(new Error('CLI fixture timed out.'));
      }, 8000);
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });
      child.once('error', (error) => {
        clearTimeout(timer);
        rejectChild(error);
      });
      child.once('exit', (code) => {
        clearTimeout(timer);
        resolveChild({ code, stdout, stderr });
      });
    });
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain('Fixture response');
    expect(shared.getSnapshot().session.id).toBe(sharedId);
    expect(shared.getSnapshot().session.entries).toEqual([]);
  }, 10_000);

  it('starts without default work and isolates one-shot sessions while preserving a shared session across detach', async () => {
    expect(host.getStatus().backgroundTasks).toBe(0);
    const shared = await client();
    const sharedId = shared.getSnapshot().session.id;
    shared.addEntry({ kind: 'notice', text: 'Shared fixture session' });
    await vi.waitFor(() => expect(shared.getSnapshot().session.entries).toHaveLength(1));
    const isolated = await client({ isolatedSession: true });
    expect(isolated.getSnapshot().session.id).not.toBe(sharedId);
    const longAnswer = 'Large Turkish ı ş 👋 output\n'.repeat(4000);
    model.doStream = async () => textStream(longAnswer);
    await isolated.sendMessage({ text: 'Isolated fixture request', images: [] }, preferences);
    await vi.waitFor(() => {
      expect(isolated.getSnapshot().busy).toBe(false);
      expect(isolated.getSnapshot().session.entries.find((entry) => entry.kind === 'assistant')).toEqual({
        kind: 'assistant',
        text: longAnswer,
      });
    });
    expect(shared.getSnapshot().session.entries).toEqual([{ kind: 'notice', text: 'Shared fixture session' }]);
    await shared.close();
    const reconnected = await client();
    expect(reconnected.getSnapshot().session.id).toBe(sharedId);
    expect(reconnected.getSnapshot().session.entries).toHaveLength(1);
  }, 10_000);

  it('preserves pending approvals across client detach and rejects a stale decision before logging the actual execution', async () => {
    const execute = vi.fn(async () => ({ status: 'completed', detail: 'fixture result' }));
    registry.register({
      providerId: 'host',
      name: 'inspect',
      description: 'Fixture tool',
      inputSchema: { type: 'object', properties: {} },
      effect: { change: 'none', data: 'local', network: 'none', reversible: 'full', outbound: 'model' },
      execute,
    });
    model.doStream = vi
      .fn()
      .mockImplementationOnce(async () =>
        stream([{ type: 'tool-call', toolCallId: 'inspect-1', toolName: 'inspect', input: '{}' }], 'tool-calls'),
      )
      .mockImplementationOnce(async () => textStream('Approved fixture complete'));
    const first = await client();
    await first.sendMessage({ text: 'Inspect fixture', images: [] }, preferences);
    await vi.waitFor(() => expect(first.getSnapshot().pendingApprovalId).toBeTruthy());
    const id = first.getSnapshot().pendingApprovalId!;
    await first.close();
    const restored = await client();
    expect(restored.getSnapshot().pendingApprovalId).toBe(id);
    restored.approveToolCall('allow', 'wrong-request-id');
    await requestHost('status');
    expect(restored.getSnapshot().pendingApprovalId).toBe(id);
    expect(execute).not.toHaveBeenCalled();
    restored.approveToolCall('allow', id);
    await vi.waitFor(() =>
      expect(
        restored.getSnapshot().session.entries.some((entry) => entry.kind === 'assistant' && entry.text === 'Approved fixture complete'),
      ).toBe(true),
    );
    expect(execute).toHaveBeenCalledTimes(1);
    const actions = (await requestHost('ledger.actions')) as Array<{ requestId: string; state: string }>;
    expect(actions).toContainEqual(expect.objectContaining({ requestId: id, state: 'completed' }));
  }, 10_000);

  it('routes a model question through session.answer, ignores a stale id, and clears it after the answer', async () => {
    const { createQuestionTool } = await import('../src/tools/question.js');
    registry.register(createQuestionTool());
    model.doStream = vi
      .fn()
      .mockImplementationOnce(async () =>
        stream(
          [
            {
              type: 'tool-call',
              toolCallId: 'ask-1',
              toolName: 'question',
              input: '{"question":"Which environment?","options":["Staging","Production"]}',
            },
          ],
          'tool-calls',
        ),
      )
      .mockImplementationOnce(async () => textStream('Deploying to Staging.'));
    const asker = await client();
    await asker.sendMessage({ text: 'Deploy fixture', images: [] }, preferences);
    await vi.waitFor(() => expect(asker.getSnapshot().pendingQuestion).not.toBeNull());
    const pending = asker.getSnapshot().pendingQuestion!;
    expect(pending.question).toBe('Which environment?');
    asker.answerQuestion(null, 'stale-question-id');
    await requestHost('status');
    expect(asker.getSnapshot().pendingQuestion?.id).toBe(pending.id);
    asker.answerQuestion('Staging', pending.id);
    await vi.waitFor(() =>
      expect(
        asker.getSnapshot().session.entries.some((entry) => entry.kind === 'assistant' && entry.text === 'Deploying to Staging.'),
      ).toBe(true),
    );
    expect(asker.getSnapshot().pendingQuestion).toBeNull();
  }, 10_000);

  it('rejoins an active isolated session instead of copying its saved transcript and losing the live approval', async () => {
    const execute = vi.fn(async () => ({ status: 'completed' }));
    registry.register({
      providerId: 'host',
      name: 'inspect',
      description: 'Fixture tool',
      inputSchema: { type: 'object', properties: {} },
      effect: { change: 'none', data: 'local', network: 'none', reversible: 'full', outbound: 'model' },
      execute,
    });
    model.doStream = vi
      .fn()
      .mockImplementationOnce(async () =>
        stream([{ type: 'tool-call', toolCallId: 'isolated-inspect', toolName: 'inspect', input: '{}' }], 'tool-calls'),
      )
      .mockImplementationOnce(async () => textStream('Recovered isolated run'));
    const viewer = await client();
    const sharedId = viewer.getSnapshot().session.id;
    const isolated = await client({ isolatedSession: true });
    const sessionId = isolated.getSnapshot().session.id;
    await isolated.sendMessage({ text: 'Isolated inspection', images: [] }, preferences);
    await vi.waitFor(() => expect(isolated.getSnapshot().pendingApprovalId).toBeTruthy());
    const requestId = isolated.getSnapshot().pendingApprovalId!;
    await isolated.close();
    await viewer.loadSession(sessionId);
    expect(viewer.getSnapshot().session.id).toBe(sessionId);
    expect(viewer.getSnapshot().pendingApprovalId).toBe(requestId);
    viewer.approveToolCall('allow', requestId);
    await vi.waitFor(() =>
      expect(
        viewer.getSnapshot().session.entries.some((entry) => entry.kind === 'assistant' && entry.text === 'Recovered isolated run'),
      ).toBe(true),
    );
    expect(execute).toHaveBeenCalledTimes(1);
    const defaultClient = await client();
    expect(defaultClient.getSnapshot().session.id).toBe(sharedId);
    expect(defaultClient.getSnapshot().session.entries).toEqual([]);
  }, 10_000);

  it('reports a failed source activation separately from saving the task definition', async () => {
    const task = {
      id: 'missing-source',
      name: 'Requested filesystem task',
      enabled: true,
      workspaceRoot: root,
      instruction: 'Notify me about selected file changes.',
      trigger: { adapter: 'filesystem', options: { path: join(root, 'missing-directory') } },
    };
    const result = (await requestHost('background.manage', { input: { action: 'add', task }, workspaceRoot: root })) as {
      status: string;
      saved: boolean;
      runtime: { state: string };
    };
    expect(result).toMatchObject({ status: 'error', saved: true, runtime: { state: 'error' } });
  });

  it('routes an explicit task through the same model and request-bound approval gate without granting native tool auto-approval', async () => {
    const execute = vi.fn(async () => ({ status: 'completed' }));
    registry.register({
      providerId: 'host',
      name: 'inspect',
      description: 'Native-auto fixture tool',
      inputSchema: { type: 'object', properties: {} },
      effect: { change: 'none', data: 'local', network: 'none', reversible: 'full', outbound: 'model' },
      autoApprove: () => true,
      execute,
    });
    model.doStream = vi
      .fn()
      .mockImplementationOnce(async () =>
        stream([{ type: 'tool-call', toolCallId: 'task-inspect', toolName: 'inspect', input: '{}' }], 'tool-calls'),
      )
      .mockImplementationOnce(async () => textStream('Task fixture finished'));
    const task = {
      id: 'explicit',
      name: 'Requested task',
      enabled: true,
      workspaceRoot: root,
      instruction: 'Inspect once when requested.',
      trigger: { adapter: 'manual', options: {} },
    };
    await requestHost('background.manage', { input: { action: 'add', task }, workspaceRoot: root });
    await requestHost('background.manage', { input: { action: 'run', taskId: task.id }, workspaceRoot: root });
    const taskClient = await client({ taskId: task.id });
    await vi.waitFor(() => expect(taskClient.getSnapshot().pendingApprovalId).toBeTruthy());
    expect(execute).not.toHaveBeenCalled();
    taskClient.approveToolCall('allow', taskClient.getSnapshot().pendingApprovalId!);
    await vi.waitFor(() =>
      expect(
        taskClient.getSnapshot().session.entries.some((entry) => entry.kind === 'assistant' && entry.text === 'Task fixture finished'),
      ).toBe(true),
    );
    const events = (await requestHost('ledger.events')) as Array<{ id: string; source: string; status: string }>;
    const triggered = events.find((event) => event.source === 'task:manual');
    const actions = (await requestHost('ledger.actions')) as Array<{ eventId: string; state: string }>;
    expect(actions).toContainEqual(expect.objectContaining({ eventId: triggered?.id, state: 'completed' }));
    expect(execute).toHaveBeenCalledTimes(1);
    expect(events.some((event) => event.source === 'notification' && event.status === 'delivered')).toBe(true);
  }, 10_000);

  it('continues the workspace main session from Telegram so one thread spans both channels', async () => {
    const settings = await import('../src/settings.js');
    const store = settings.defaultSettings();
    store.telegram = { enabled: true, tokenEnv: 'FTG_TOKEN', workspaceRoot: root, chatId: '1', userId: '2' };
    settings.saveSettings(store);
    const viewer = await client();
    const mainId = viewer.getSnapshot().session.id;

    await host.receiveTelegramMessage(11, 'Merhaba from Telegram');

    await vi.waitFor(() =>
      expect(viewer.getSnapshot().session.entries.some((entry) => entry.kind === 'assistant' && entry.text === 'Fixture response')).toBe(
        true,
      ),
    );
    expect(viewer.getSnapshot().session.id).toBe(mainId);
    expect(viewer.getSnapshot().session.entries).toContainEqual(
      expect.objectContaining({ kind: 'user', text: 'Merhaba from Telegram', source: 'telegram' }),
    );
  }, 10_000);

  it('delivers the setup test message to the paired owner chat and refuses it before pairing', async () => {
    const settings = await import('../src/settings.js');
    const store = settings.defaultSettings();
    store.telegram = { enabled: true, tokenEnv: 'FTG_SETUP_TOKEN', workspaceRoot: root, chatId: '42', userId: '7' };
    settings.saveSettings(store);
    vi.stubEnv('FTG_SETUP_TOKEN', '123456:fixture-setup-token-value-ok');
    const sent: Array<Record<string, unknown>> = [];
    const fetchStub = vi.fn(async (url: unknown, init?: RequestInit) => {
      const method = String(url).split('/').at(-1);
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      let result: unknown = true;
      if (method === 'getMe') result = { is_bot: true, username: 'setup_bot' };
      if (method === 'getWebhookInfo') result = {};
      if (method === 'sendMessage') {
        sent.push(body);
        result = { message_id: sent.length };
      }
      if (method === 'getUpdates') {
        result = await new Promise<unknown[]>((_resolveUpdates, rejectUpdates) => {
          init?.signal?.addEventListener('abort', () => rejectUpdates(new Error('Fixture polling aborted.')), { once: true });
        });
      }
      return new Response(JSON.stringify({ ok: true, result }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchStub);
    try {
      const reloaded = (await requestHost('settings.reload', {})) as { telegram?: { state: string; paired: boolean } | null };
      expect(reloaded.telegram?.state).toBe('polling');
      await expect(requestHost('telegram.test', { message: 'setup says hi' })).resolves.toEqual({ delivered: true });
      expect(sent).toContainEqual(expect.objectContaining({ chat_id: '42', parse_mode: 'HTML' }));
      expect(String(sent[0]?.text)).toContain('setup says hi');
      await expect(requestHost('telegram.test', {})).resolves.toEqual({ delivered: true });
      expect(sent.at(-1)).toMatchObject({ chat_id: '42' });

      const unpaired = settings.defaultSettings();
      unpaired.telegram = { enabled: true, tokenEnv: 'FTG_SETUP_TOKEN', workspaceRoot: root };
      settings.saveSettings(unpaired);
      await requestHost('settings.reload', {});
      await expect(requestHost('telegram.test', {})).rejects.toThrow(/not paired yet/);
    } finally {
      vi.unstubAllGlobals();
    }
  }, 15_000);

  it('stops the running turn from Telegram while queued messages stay queued', async () => {
    const settings = await import('../src/settings.js');
    const store = settings.defaultSettings();
    store.telegram = { enabled: true, tokenEnv: 'FTG_TOKEN', workspaceRoot: root, chatId: '1', userId: '2' };
    settings.saveSettings(store);
    const viewer = await client();

    model.doStream = vi.fn().mockImplementationOnce(async () => {
      let timer: NodeJS.Timeout | undefined;
      return {
        stream: new ReadableStream<LanguageModelV3StreamPart>({
          start(controller) {
            controller.enqueue({ type: 'stream-start', warnings: [] });
            controller.enqueue({ type: 'text-start', id: 'long' });
            controller.enqueue({ type: 'text-delta', id: 'long', delta: 'Still working…' });
            timer = setInterval(() => {
              try {
                controller.enqueue({ type: 'text-delta', id: 'long', delta: '.' });
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
    });
    await host.receiveTelegramMessage(21, 'First long request');
    await vi.waitFor(() => expect(viewer.getSnapshot().busy).toBe(true));

    await host.receiveTelegramMessage(22, 'Second queued request');
    model.doStream = vi.fn(async () => textStream('Fixture response'));
    await host.receiveTelegramMessage(23, '/stop');

    await vi.waitFor(
      () =>
        expect(viewer.getSnapshot().session.entries.some((entry) => entry.kind === 'user' && entry.text === 'Second queued request')).toBe(
          true,
        ),
      { timeout: 8_000 },
    );
    await vi.waitFor(() =>
      expect(viewer.getSnapshot().session.entries.some((entry) => entry.kind === 'assistant' && entry.text === 'Fixture response')).toBe(
        true,
      ),
    );
  }, 15_000);

  it('removes the reply keyboard when the owner chat is unpaired', async () => {
    const settings = await import('../src/settings.js');
    const store = settings.defaultSettings();
    store.telegram = { enabled: true, tokenEnv: 'FTG_FAREWELL_TOKEN', workspaceRoot: root, chatId: '42', userId: '7' };
    settings.saveSettings(store);
    vi.stubEnv('FTG_FAREWELL_TOKEN', '123456:fixture-farewell-token-ok');
    const sent: Array<Record<string, unknown>> = [];
    const fetchStub = vi.fn(async (url: unknown, init?: RequestInit) => {
      const method = String(url).split('/').at(-1);
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      let result: unknown = true;
      if (method === 'getMe') result = { is_bot: true, username: 'farewell_bot' };
      if (method === 'getWebhookInfo') result = {};
      if (method === 'sendMessage') {
        sent.push(body);
        result = { message_id: sent.length };
      }
      if (method === 'getUpdates') {
        result = await new Promise<unknown[]>((_resolveUpdates, rejectUpdates) => {
          init?.signal?.addEventListener('abort', () => rejectUpdates(new Error('Fixture polling aborted.')), { once: true });
        });
      }
      return new Response(JSON.stringify({ ok: true, result }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchStub);
    try {
      await requestHost('settings.reload', {});
      const unpaired = settings.defaultSettings();
      unpaired.telegram = { enabled: true, tokenEnv: 'FTG_FAREWELL_TOKEN', workspaceRoot: root };
      settings.saveSettings(unpaired);
      await requestHost('settings.reload', {});
      const farewell = sent.find(
        (body) =>
          typeof body.reply_markup === 'object' &&
          body.reply_markup !== null &&
          (body.reply_markup as Record<string, unknown>).remove_keyboard === true,
      );
      expect(farewell).toMatchObject({ chat_id: '42' });
      expect(String(farewell?.text)).toMatch(/disconnected/);
    } finally {
      vi.unstubAllGlobals();
    }
  }, 15_000);

  it('lets the custodian steer a live worker and refuses worker-to-worker messages', async () => {
    const viewer = await client();
    const mainId = viewer.getSnapshot().session.id;
    const worker = await client({ isolatedSession: true });
    await worker.sendMessage({ text: 'Worker standing by.', images: [] }, preferences);
    await vi.waitFor(() =>
      expect(worker.getSnapshot().session.entries.some((entry) => entry.kind === 'assistant' && entry.text === 'Fixture response')).toBe(
        true,
      ),
    );
    await worker.flushSave();
    const workerId = worker.getSnapshot().session.id;

    let viewerStep = 0;
    model.doStream = vi.fn(async (options: { prompt?: unknown }) => {
      const serialized = JSON.stringify(options.prompt ?? []);
      if (serialized.includes('Tell the worker to wrap up.')) {
        viewerStep += 1;
        if (viewerStep === 1)
          return stream(
            [
              {
                type: 'tool-call',
                toolCallId: 'steer-1',
                toolName: 'session_message',
                input: JSON.stringify({ session: workerId, text: 'Wrap up soon.' }),
              },
            ],
            'tool-calls',
          );
        return textStream('Steered the worker.');
      }
      if (serialized.includes('Wrap up soon.')) return textStream('Worker acknowledges.');
      return textStream('Fixture response');
    });

    await viewer.sendMessage({ text: 'Tell the worker to wrap up.', images: [] }, preferences);
    await vi.waitFor(() =>
      expect(viewer.getSnapshot().session.entries.some((entry) => entry.kind === 'assistant' && entry.text === 'Steered the worker.')).toBe(
        true,
      ),
    );
    await vi.waitFor(() =>
      expect(
        worker.getSnapshot().session.entries.some((entry) => entry.kind === 'user' && String(entry.text).includes('Wrap up soon.')),
      ).toBe(true),
    );
    const delivered = worker
      .getSnapshot()
      .session.entries.find((entry) => entry.kind === 'user' && String(entry.text).includes('Wrap up soon.'));
    expect(delivered?.kind === 'user' ? delivered.text : '').toContain('custodian session');
    expect(delivered?.kind === 'user' ? delivered.text : '').toContain('not from the user');
    await vi.waitFor(() =>
      expect(
        worker.getSnapshot().session.entries.some((entry) => entry.kind === 'assistant' && entry.text === 'Worker acknowledges.'),
      ).toBe(true),
    );

    let attemptStep = 0;
    model.doStream = vi.fn(async (options: { prompt?: unknown }) => {
      const serialized = JSON.stringify(options.prompt ?? []);
      if (serialized.includes('Attempt worker-to-worker steering.')) {
        attemptStep += 1;
        if (attemptStep === 1)
          return stream(
            [
              {
                type: 'tool-call',
                toolCallId: 'steer-2',
                toolName: 'session_message',
                input: JSON.stringify({ session: mainId, text: 'Take over.' }),
              },
            ],
            'tool-calls',
          );
        return textStream('Refused.');
      }
      return textStream('Fixture response');
    });
    await worker.sendMessage({ text: 'Attempt worker-to-worker steering.', images: [] }, preferences);
    await vi.waitFor(() =>
      expect(worker.getSnapshot().session.entries.some((entry) => entry.kind === 'assistant' && entry.text === 'Refused.')).toBe(true),
    );
    expect(viewer.getSnapshot().session.entries.some((entry) => entry.kind === 'user' && String(entry.text).includes('Take over.'))).toBe(
      false,
    );
  }, 15_000);

  it('runs a foreground subagent with a mode-restricted tool set and returns its report', async () => {
    registerFakeTool('file_read');
    registerFakeTool('file_write');
    registerFakeTool('execute_command');
    const viewer = await client();
    const workerNames: string[] = [];
    const parentNames: string[] = [];
    let parentStep = 0;
    model.doStream = vi.fn(async (options: { prompt?: unknown; tools?: unknown }) => {
      const serialized = JSON.stringify(options.prompt ?? []);
      const names = offeredToolNames(options);
      if (serialized.includes('You are a worker session')) {
        workerNames.push(...names);
        return textStream('WORKER-REPORT: inspected README.');
      }
      parentNames.push(...names);
      if (serialized.includes('WORKER-REPORT')) return textStream('PARENT-SUMMARY: the worker reported back.');
      parentStep += 1;
      if (parentStep === 1)
        return stream(
          [
            {
              type: 'tool-call',
              toolCallId: 'subagent-1',
              toolName: 'subagent',
              input: JSON.stringify({
                task: 'PARENT-TASK: inspect README',
                mode: 'explorer',
                background: false,
                context: { paths: ['README.md'] },
              }),
            },
          ],
          'tool-calls',
        );
      return textStream('PARENT-WAITING');
    });

    await viewer.sendMessage({ text: 'Delegate the README inspection.', images: [] }, preferences);
    await vi.waitFor(() =>
      expect(
        viewer
          .getSnapshot()
          .session.entries.some((entry) => entry.kind === 'assistant' && entry.text === 'PARENT-SUMMARY: the worker reported back.'),
      ).toBe(true),
    );

    expect(parentNames).toContain('subagent');
    expect(parentNames).toContain('file_read');
    expect(workerNames).toContain('file_read');
    expect(workerNames).not.toContain('file_write');
    expect(workerNames).not.toContain('execute_command');
    expect(workerNames).not.toContain('subagent');
    expect(workerNames).not.toContain('parent_message');
    const toolResult = viewer
      .getSnapshot()
      .session.entries.find((entry) => entry.kind === 'tool' && entry.result.includes('WORKER-REPORT'));
    expect(toolResult?.kind === 'tool' ? toolResult.command : '').toMatch(/^subagent explorer/);
  }, 15_000);

  it('lets an executor subagent start one child layer but not a third layer', async () => {
    registerFakeTool('file_read');
    registerFakeTool('file_write');
    registerFakeTool('execute_command');
    const viewer = await client();
    const childNames: string[] = [];
    const grandchildNames: string[] = [];
    let childStep = 0;
    model.doStream = vi.fn(async (options: { prompt?: unknown; tools?: unknown }) => {
      const serialized = JSON.stringify(options.prompt ?? []);
      const names = offeredToolNames(options);
      if (serialized.includes('You are a worker session')) {
        if (serialized.includes('CHILD-TASK')) {
          childStep += 1;
          if (childStep === 1) {
            childNames.push(...names);
            return stream(
              [
                {
                  type: 'tool-call',
                  toolCallId: 'subagent-2',
                  toolName: 'subagent',
                  input: JSON.stringify({ task: 'GRAND-TASK: inspect deeper', mode: 'executor', background: false }),
                },
              ],
              'tool-calls',
            );
          }
          return textStream('CHILD-REPORT: child finished.');
        }
        grandchildNames.push(...names);
        return textStream('GRAND-REPORT: deeper inspection done.');
      }
      if (serialized.includes('CHILD-REPORT')) return textStream('PARENT-SUMMARY-NESTED: nested worker finished.');
      return stream(
        [
          {
            type: 'tool-call',
            toolCallId: 'subagent-parent',
            toolName: 'subagent',
            input: JSON.stringify({ task: 'CHILD-TASK: delegate deeper', mode: 'executor', background: false }),
          },
        ],
        'tool-calls',
      );
    });

    await viewer.sendMessage({ text: 'Delegate the deep inspection.', images: [] }, preferences);
    await vi.waitFor(() =>
      expect(
        viewer
          .getSnapshot()
          .session.entries.some((entry) => entry.kind === 'assistant' && entry.text === 'PARENT-SUMMARY-NESTED: nested worker finished.'),
      ).toBe(true),
    );

    expect(childNames).toContain('subagent');
    expect(childNames).toContain('file_write');
    expect(grandchildNames).toContain('file_read');
    expect(grandchildNames).toContain('file_write');
    expect(grandchildNames).not.toContain('subagent');
    const toolResult = viewer.getSnapshot().session.entries.find((entry) => entry.kind === 'tool' && entry.result.includes('CHILD-REPORT'));
    expect(toolResult).toBeDefined();
  }, 15_000);

  it('opens a subagent session view-only and refuses messages to it', async () => {
    const viewer = await client();
    const mainId = viewer.getSnapshot().session.id;
    let releaseWorker!: () => void;
    const workerGate = new Promise<void>((resolve) => {
      releaseWorker = resolve;
    });
    let parentStep = 0;
    model.doStream = vi.fn(async (options: { prompt?: unknown }) => {
      const serialized = JSON.stringify(options.prompt ?? []);
      if (serialized.includes('You are a worker session')) {
        await workerGate;
        return textStream('WORKER-REPORT: view test done.');
      }
      if (serialized.includes('WORKER-REPORT')) return textStream('PARENT-SUMMARY: view test done.');
      parentStep += 1;
      if (parentStep === 1)
        return stream(
          [
            {
              type: 'tool-call',
              toolCallId: 'subagent-view',
              toolName: 'subagent',
              input: JSON.stringify({ task: 'VIEW-TASK: wait for the gate', mode: 'explorer', background: false }),
            },
          ],
          'tool-calls',
        );
      return textStream('PARENT-WAITING');
    });

    const parentRun = viewer.sendMessage({ text: 'Delegate the view test.', images: [] }, preferences);
    await vi.waitFor(() =>
      expect(viewer.getSnapshot().session.entries.some((entry) => entry.kind === 'tool' && entry.running === true)).toBe(true),
    );

    const live = await client({ runningWorkerOf: mainId });
    expect(live.getSnapshot().session.id).not.toBe(mainId);
    expect(live.getSnapshot().busy).toBe(true);
    expect(live.getSnapshot().session.entries.some((entry) => entry.kind === 'user' && String(entry.text).includes('VIEW-TASK'))).toBe(
      true,
    );
    await live.sendMessage({ text: 'Are you done?', images: [] }, preferences);
    expect(live.getSnapshot().session.entries.some((entry) => entry.kind === 'notice' && entry.text.includes('view-only'))).toBe(true);

    releaseWorker();
    await parentRun;
    await vi.waitFor(() =>
      expect(
        viewer
          .getSnapshot()
          .session.entries.some((entry) => entry.kind === 'assistant' && entry.text === 'PARENT-SUMMARY: view test done.'),
      ).toBe(true),
    );

    const toolEntry = viewer.getSnapshot().session.entries.find((entry) => entry.kind === 'tool' && entry.result.includes('WORKER-REPORT'));
    const workerId = toolEntry?.kind === 'tool' ? toolEntry.session : undefined;
    expect(workerId).toMatch(/^[0-9a-f-]{36}$/);
    const completed = await client({ workerSessionId: workerId! });
    expect(completed.getSnapshot().session.id).toBe(workerId);
    expect(
      completed.getSnapshot().session.entries.some((entry) => entry.kind === 'assistant' && entry.text.includes('WORKER-REPORT')),
    ).toBe(true);
  }, 20_000);

  it('runs a background subagent without blocking; the parent polls its notes and final report', async () => {
    registerFakeTool('file_read');
    registerFakeTool('file_write');
    registerFakeTool('execute_command');
    const viewer = await client();
    const workerNames: string[] = [];
    let parentStep = 0;
    let workerStep = 0;
    let sawNote = false;
    let releaseWorker!: () => void;
    const workerGate = new Promise<void>((resolve) => {
      releaseWorker = resolve;
    });
    const workerIdFrom = (serialized: string): string => {
      const match = /\\?"session\\?":\s*\\?"([0-9a-f-]{36})\\?"/.exec(serialized);
      return match ? match[1]! : 'missing';
    };
    model.doStream = vi.fn(async (options: { prompt?: unknown; tools?: unknown }) => {
      const serialized = JSON.stringify(options.prompt ?? []);
      if (serialized.includes('You are a worker session')) {
        if (workerStep === 0) {
          workerStep += 1;
          workerNames.push(...offeredToolNames(options));
          return stream(
            [
              {
                type: 'tool-call',
                toolCallId: 'pm-1',
                toolName: 'parent_message',
                input: JSON.stringify({ text: 'PROGRESS-NOTE: halfway there.' }),
              },
            ],
            'tool-calls',
          );
        }
        await workerGate;
        return textStream('WORKER-REPORT: background done.');
      }
      if (/\\?"report\\?":\\?"WORKER-REPORT/.test(serialized)) return textStream('PARENT-DONE: read the final report.');
      if (!sawNote && serialized.includes('PROGRESS-NOTE')) {
        sawNote = true;
        return textStream('PARENT-SAW-NOTE: got it, will check the report later.');
      }
      parentStep += 1;
      if (parentStep === 1) {
        return stream(
          [
            {
              type: 'tool-call',
              toolCallId: 'bg-1',
              toolName: 'subagent',
              input: JSON.stringify({ task: 'BG-TASK: work in the background', mode: 'executor', background: true }),
            },
          ],
          'tool-calls',
        );
      }
      if (parentStep > 40) {
        return textStream('PARENT-GAVE-UP: poll loop did not converge.');
      }
      return stream(
        [
          {
            type: 'tool-call',
            toolCallId: `poll-${parentStep}`,
            toolName: 'subagent_poll',
            input: JSON.stringify({ session: workerIdFrom(serialized) }),
          },
        ],
        'tool-calls',
      );
    });

    await viewer.sendMessage({ text: 'Delegate in background.', images: [] }, preferences);
    await vi.waitFor(() =>
      expect(
        viewer
          .getSnapshot()
          .session.entries.some(
            (entry) => entry.kind === 'assistant' && entry.text === 'PARENT-SAW-NOTE: got it, will check the report later.',
          ),
      ).toBe(true),
    );

    const spawnResult = viewer
      .getSnapshot()
      .session.entries.find((entry) => entry.kind === 'tool' && entry.command.startsWith('subagent ') && typeof entry.session === 'string');
    expect(spawnResult).toBeDefined();
    expect(workerNames).toContain('parent_message');
    expect(workerNames).toContain('file_write');
    expect(workerNames).toContain('subagent');
    const notePoll = viewer.getSnapshot().session.entries.find((entry) => entry.kind === 'tool' && entry.result.includes('PROGRESS-NOTE'));
    expect(notePoll).toBeDefined();
    const noteResult = notePoll?.kind === 'tool' ? notePoll.result : '';
    expect(noteResult).toContain('Running');
    expect(noteResult).toContain('1 call');
    expect(noteResult).toContain('parent_message');

    releaseWorker();
    await viewer.sendMessage({ text: 'Check the final report.', images: [] }, preferences);
    await vi.waitFor(() =>
      expect(
        viewer
          .getSnapshot()
          .session.entries.some((entry) => entry.kind === 'assistant' && entry.text === 'PARENT-DONE: read the final report.'),
      ).toBe(true),
    );
    const reportPoll = viewer
      .getSnapshot()
      .session.entries.find((entry) => entry.kind === 'tool' && entry.result.includes('WORKER-REPORT'));
    expect(reportPoll).toBeDefined();
    expect(
      viewer
        .getSnapshot()
        .session.entries.some((entry) => entry.kind === 'user' && String(entry.text).includes('Background subagent finished')),
    ).toBe(false);
  }, 20_000);

  it('lets only the parent stop its background worker', async () => {
    registerFakeTool('file_read');
    const viewer = await client();
    let parentStep = 0;
    let isolatedStep = 0;
    let capturedWorkerId = '';
    const abortableWorkerStream = (signal?: AbortSignal | null) => ({
      stream: new ReadableStream<LanguageModelV3StreamPart>({
        start(controller) {
          controller.enqueue({ type: 'stream-start', warnings: [] });
          controller.enqueue({ type: 'text-start', id: 'work' });
          controller.enqueue({ type: 'text-delta', id: 'work', delta: 'Working…' });
          const finish = () => {
            try {
              controller.enqueue({ type: 'text-end', id: 'work' });
              controller.enqueue({ type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage });
              controller.close();
            } catch {
              /* already closed */
            }
          };
          if (signal?.aborted) finish();
          else signal?.addEventListener('abort', finish, { once: true });
        },
      }),
    });
    const workerIdFrom = (serialized: string): string => {
      const match = /\\?"session\\?":\\?"([0-9a-f-]{36})\\?"/.exec(serialized);
      return match ? match[1]! : 'missing';
    };
    model.doStream = vi.fn(async (options: { prompt?: unknown; tools?: unknown; abortSignal?: AbortSignal | null }) => {
      const serialized = JSON.stringify(options.prompt ?? []);
      if (serialized.includes('You are a worker session')) {
        return abortableWorkerStream(options.abortSignal ?? null);
      }
      if (serialized.includes('ISOLATED-PROBE')) {
        isolatedStep += 1;
        if (isolatedStep === 1)
          return stream(
            [
              {
                type: 'tool-call',
                toolCallId: 'stop-x',
                toolName: 'subagent_stop',
                input: JSON.stringify({ session: capturedWorkerId }),
              },
            ],
            'tool-calls',
          );
        return textStream('ISOLATED-DONE');
      }
      if (/\\?"status\\?":\\?"finished"/.test(serialized)) return textStream('PARENT-DONE: worker halted.');
      if (serialized.includes('Check it.'))
        return stream(
          [
            {
              type: 'tool-call',
              toolCallId: 'poll-check-1',
              toolName: 'subagent_poll',
              input: JSON.stringify({ session: workerIdFrom(serialized) }),
            },
          ],
          'tool-calls',
        );
      parentStep += 1;
      if (parentStep === 1)
        return stream(
          [
            {
              type: 'tool-call',
              toolCallId: 'bg-stop-1',
              toolName: 'subagent',
              input: JSON.stringify({ task: 'BG-STOP-TASK: wait to be stopped', mode: 'executor', background: true }),
            },
          ],
          'tool-calls',
        );
      if (parentStep === 2) {
        capturedWorkerId = workerIdFrom(serialized);
        return stream(
          [
            {
              type: 'tool-call',
              toolCallId: 'poll-stop-1',
              toolName: 'subagent_poll',
              input: JSON.stringify({ session: capturedWorkerId }),
            },
          ],
          'tool-calls',
        );
      }
      if (parentStep === 3)
        return stream(
          [
            {
              type: 'tool-call',
              toolCallId: 'stop-1',
              toolName: 'subagent_stop',
              input: JSON.stringify({ session: capturedWorkerId }),
            },
          ],
          'tool-calls',
        );
      if (parentStep === 4) return textStream('PARENT-STOPPED: stop call sent.');
      if (parentStep > 8) return textStream('PARENT-GAVE-UP: stop loop did not converge.');
      return stream(
        [
          {
            type: 'tool-call',
            toolCallId: `poll-stop-${parentStep}`,
            toolName: 'subagent_poll',
            input: JSON.stringify({ session: capturedWorkerId }),
          },
        ],
        'tool-calls',
      );
    });

    await viewer.sendMessage({ text: 'Stop the worker test.', images: [] }, preferences);
    await vi.waitFor(() =>
      expect(
        viewer
          .getSnapshot()
          .session.entries.some((entry) => entry.kind === 'assistant' && entry.text === 'PARENT-STOPPED: stop call sent.'),
      ).toBe(true),
    );
    const spawnResult = viewer
      .getSnapshot()
      .session.entries.find((entry) => entry.kind === 'tool' && entry.command.startsWith('subagent ') && typeof entry.session === 'string');
    expect(spawnResult).toBeDefined();
    const stopResult = viewer.getSnapshot().session.entries.find((entry) => entry.kind === 'tool' && entry.command.startsWith('Stop '));
    expect(stopResult).toBeDefined();
    const spawnedWorkerId = spawnResult?.kind === 'tool' ? spawnResult.session : undefined;
    expect(spawnedWorkerId).toMatch(/^[0-9a-f-]{36}$/);

    const workerView = await client({ workerSessionId: spawnedWorkerId! });
    expect(workerView.getSnapshot().session.id).toBe(spawnedWorkerId);
    await vi.waitFor(() => expect(workerView.getSnapshot().busy).toBe(false), { timeout: 10_000 });

    await viewer.sendMessage({ text: 'Check it.', images: [] }, preferences);
    await vi.waitFor(() =>
      expect(
        viewer.getSnapshot().session.entries.some((entry) => entry.kind === 'assistant' && entry.text === 'PARENT-DONE: worker halted.'),
      ).toBe(true),
    );
    const finalPoll = viewer
      .getSnapshot()
      .session.entries.find((entry) => entry.kind === 'tool' && entry.session === capturedWorkerId && entry.result.includes('Finished'));
    expect(finalPoll).toBeDefined();
    expect(finalPoll?.kind === 'tool' ? finalPoll.result : '').toContain('Run cancelled.');
    expect(
      viewer.getSnapshot().session.entries.some((entry) => entry.kind === 'assistant' && entry.text === 'WORKER-SHOULD-NOT-ARRIVE'),
    ).toBe(false);

    const isolated = await client({ isolatedSession: true });
    await isolated.sendMessage({ text: 'ISOLATED-PROBE stop please.', images: [] }, preferences);
    await vi.waitFor(() =>
      expect(
        isolated.getSnapshot().session.entries.some((entry) => entry.kind === 'tool' && entry.result.includes('Only the parent')),
      ).toBe(true),
    );
    const denied = isolated
      .getSnapshot()
      .session.entries.find((entry) => entry.kind === 'tool' && entry.result.includes('Only the parent'));
    expect(denied?.kind === 'tool' ? denied.result : '').toContain('may stop it');
  }, 20_000);

  it('caps a parent at eight running workers and frees the slot when one stops', async () => {
    const viewer = await client();
    let parentStep = 0;
    let retrySpawned = false;
    const spawnCall = (callId: string, task: string) => ({
      type: 'tool-call' as const,
      toolCallId: callId,
      toolName: 'subagent',
      input: JSON.stringify({ task, mode: 'executor', background: true }),
    });
    model.doStream = vi.fn(async (options: { prompt?: unknown; abortSignal?: AbortSignal | null }) => {
      const serialized = JSON.stringify(options.prompt ?? []);
      if (serialized.includes('You are a worker session')) return holdOpenWorkerStream(options.abortSignal ?? null);
      if (serialized.includes('Retry after release.')) {
        if (retrySpawned) return textStream('CAP-RETRY-OK');
        retrySpawned = true;
        return stream([spawnCall('cap-m9r', 'CAP-M9R: the retried worker')], 'tool-calls');
      }
      parentStep += 1;
      if (parentStep <= 8) return stream([spawnCall(`cap-m${parentStep}`, `CAP-M${parentStep}: hold until stopped`)], 'tool-calls');
      if (parentStep === 9) return stream([spawnCall('cap-m9', 'CAP-M9: over the cap')], 'tool-calls');
      return textStream('CAP-BUSY-SEEN');
    });

    await viewer.sendMessage({ text: 'Fill the worker cap.', images: [] }, preferences);
    await vi.waitFor(() =>
      expect(viewer.getSnapshot().session.entries.some((entry) => entry.kind === 'assistant' && entry.text === 'CAP-BUSY-SEEN')).toBe(true),
    );
    const toolEntries = viewer.getSnapshot().session.entries.filter((entry) => entry.kind === 'tool');
    const started = toolEntries
      .map((entry) => (entry.kind === 'tool' ? entry.session : undefined))
      .filter((session): session is string => typeof session === 'string');
    expect(started).toHaveLength(8);
    const busy = toolEntries.find((entry) => entry.kind === 'tool' && entry.session === undefined && entry.command.startsWith('subagent '));
    expect(busy?.kind === 'tool' ? busy.result : '').toContain('limit 8');
    const workerIds = started;

    const firstView = await client({ workerSessionId: workerIds[0]! });
    firstView.stop();
    await vi.waitFor(() => expect(firstView.getSnapshot().busy).toBe(false), { timeout: 10_000 });

    await viewer.sendMessage({ text: 'Retry after release.', images: [] }, preferences);
    await vi.waitFor(() =>
      expect(viewer.getSnapshot().session.entries.some((entry) => entry.kind === 'assistant' && entry.text === 'CAP-RETRY-OK')).toBe(true),
    );
    const startedAfter = viewer
      .getSnapshot()
      .session.entries.filter((entry) => entry.kind === 'tool')
      .map((entry) => (entry.kind === 'tool' ? entry.session : undefined))
      .filter((session): session is string => typeof session === 'string');
    expect(startedAfter).toHaveLength(9);
    const retriedId = startedAfter[8]!;

    for (const workerId of [...workerIds.slice(1), retriedId]) {
      const view = await client({ workerSessionId: workerId });
      view.stop();
      await vi.waitFor(() => expect(view.getSnapshot().busy).toBe(false), { timeout: 10_000 });
    }
  }, 30_000);

  it('caps a worker parent at two children and lets the worker stop them', async () => {
    const viewer = await client();
    let parentStep = 0;
    let workerStep = 0;
    const uuidsIn = (serialized: string): string[] =>
      [...serialized.matchAll(/\\?"session\\?":\\?"([0-9a-f-]{36})\\?"/g)].map((match) => match[1]!);
    const spawnChild = (callId: string, task: string) => ({
      type: 'tool-call' as const,
      toolCallId: callId,
      toolName: 'subagent',
      input: JSON.stringify({ task, mode: 'explorer', background: true }),
    });
    const stopCall = (callId: string, session: string) => ({
      type: 'tool-call' as const,
      toolCallId: callId,
      toolName: 'subagent_stop',
      input: JSON.stringify({ session }),
    });
    model.doStream = vi.fn(async (options: { prompt?: unknown; abortSignal?: AbortSignal | null }) => {
      const serialized = JSON.stringify(options.prompt ?? []);
      if (serialized.includes('You are a worker session') && serialized.includes('CHILD-CAP-W')) {
        workerStep += 1;
        const ids = uuidsIn(serialized);
        if (workerStep === 1) return stream([spawnChild('child-1', 'CHILD-C1: wait to be stopped')], 'tool-calls');
        if (workerStep === 2) return stream([spawnChild('child-2', 'CHILD-C2: wait to be stopped')], 'tool-calls');
        if (workerStep === 3) return stream([spawnChild('child-3', 'CHILD-C3: over the cap')], 'tool-calls');
        if (workerStep === 4) return stream([stopCall('stop-c1', ids[0]!)], 'tool-calls');
        if (workerStep === 5) return stream([stopCall('stop-c2', ids[1]!)], 'tool-calls');
        return textStream('WORKER-CAP-DONE');
      }
      if (serialized.includes('You are a worker session')) return holdOpenWorkerStream(options.abortSignal ?? null);
      parentStep += 1;
      if (parentStep === 1)
        return stream(
          [
            {
              type: 'tool-call',
              toolCallId: 'cap-w',
              toolName: 'subagent',
              input: JSON.stringify({ task: 'CHILD-CAP-W: manage children', mode: 'executor', background: true }),
            },
          ],
          'tool-calls',
        );
      return textStream('CHILD-CAP-STARTED');
    });

    await viewer.sendMessage({ text: 'Run the child cap test.', images: [] }, preferences);
    await vi.waitFor(() =>
      expect(viewer.getSnapshot().session.entries.some((entry) => entry.kind === 'assistant' && entry.text === 'CHILD-CAP-STARTED')).toBe(
        true,
      ),
    );
    const spawned = viewer
      .getSnapshot()
      .session.entries.find((entry) => entry.kind === 'tool' && entry.command.startsWith('subagent ') && typeof entry.session === 'string');
    const workerId = spawned?.kind === 'tool' ? spawned.session : undefined;
    expect(workerId).toMatch(/^[0-9a-f-]{36}$/);

    const { loadSavedSession: loadWorkerSession } = await import('../src/session-store.js');
    await vi.waitFor(
      () => {
        const done = loadWorkerSession(workerId!)?.entries.some((entry) => entry.kind === 'assistant' && entry.text === 'WORKER-CAP-DONE');
        expect(done).toBe(true);
      },
      { timeout: 15_000 },
    );
    const results = (loadWorkerSession(workerId!)?.entries ?? [])
      .filter((entry) => entry.kind === 'tool')
      .map((entry) => String((entry as { result?: unknown }).result ?? ''));
    expect(results.filter((result) => result.includes('Started'))).toHaveLength(2);
    const childBusy = results.find((result) => result.includes('limit 2'));
    expect(childBusy ?? '').toContain('already runs 2 subagents');
    expect(results.filter((result) => result.includes('Stopped'))).toHaveLength(2);
  }, 20_000);

  it('locks a file to the worker that writes it until its run ends', async () => {
    registry.register({
      providerId: 'fixture',
      name: 'file_write',
      description: 'Fixture file write that honours the worker write lease.',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
        additionalProperties: false,
      },
      effect: { change: 'modify', data: 'public', network: 'none', reversible: 'full', outbound: 'none' },
      resolveTarget: (input) => resolve(root, String((input as { path?: unknown }).path ?? '')),
      workspaceScope: () => 'workspace',
      execute: async (input: unknown, _signal?: AbortSignal, context?: { guardWrite?: (path: string) => string | null }) => {
        const path = String((input as { path?: unknown }).path ?? '');
        const denied = context?.guardWrite?.(path);
        return denied ? { status: 'denied', error: denied } : { status: 'completed', path };
      },
    });
    const viewer = await client();
    let parentStep = 0;
    let w1Step = 0;
    let w2Step = 0;
    let w1Wrote!: () => void;
    const w1WrotePromise = new Promise<void>((resolve) => {
      w1Wrote = resolve;
    });
    let releaseW1!: () => void;
    const w1StoppedPromise = new Promise<void>((resolve) => {
      releaseW1 = resolve;
    });
    const writeCall = (callId: string) => ({
      type: 'tool-call' as const,
      toolCallId: callId,
      toolName: 'fixture__file_write',
      input: JSON.stringify({ path: 'shared.txt', content: 'lease' }),
    });
    model.doStream = vi.fn(async (options: { prompt?: unknown; abortSignal?: AbortSignal | null }) => {
      const serialized = JSON.stringify(options.prompt ?? []);
      if (serialized.includes('You are a worker session') && serialized.includes('LEASE-W1')) {
        w1Step += 1;
        if (w1Step === 1) return stream([writeCall('lease-w1-write')], 'tool-calls');
        w1Wrote();
        return holdOpenWorkerStream(options.abortSignal ?? null);
      }
      if (serialized.includes('You are a worker session') && serialized.includes('LEASE-W2')) {
        w2Step += 1;
        if (w2Step === 1) {
          await w1WrotePromise;
          return stream([writeCall('lease-w2-write-1')], 'tool-calls');
        }
        if (w2Step === 2) {
          await w1StoppedPromise;
          return stream([writeCall('lease-w2-write-2')], 'tool-calls');
        }
        return textStream('LEASE-DONE');
      }
      if (serialized.includes('You are a worker session')) return holdOpenWorkerStream(options.abortSignal ?? null);
      parentStep += 1;
      if (parentStep === 1)
        return stream(
          [
            {
              type: 'tool-call',
              toolCallId: 'lease-w1',
              toolName: 'subagent',
              input: JSON.stringify({ task: 'LEASE-W1: write first', mode: 'executor', background: true }),
            },
          ],
          'tool-calls',
        );
      if (parentStep === 2)
        return stream(
          [
            {
              type: 'tool-call',
              toolCallId: 'lease-w2',
              toolName: 'subagent',
              input: JSON.stringify({ task: 'LEASE-W2: write second', mode: 'executor', background: true }),
            },
          ],
          'tool-calls',
        );
      return textStream('LEASE-STARTED');
    });

    await viewer.sendMessage({ text: 'Run the lease test.', images: [] }, preferences);
    await vi.waitFor(() =>
      expect(viewer.getSnapshot().session.entries.some((entry) => entry.kind === 'assistant' && entry.text === 'LEASE-STARTED')).toBe(true),
    );
    await w1WrotePromise;
    const spawned = viewer
      .getSnapshot()
      .session.entries.filter((entry) => entry.kind === 'tool')
      .map((entry) => (entry.kind === 'tool' ? entry.session : undefined))
      .filter((session): session is string => typeof session === 'string');
    expect(spawned).toHaveLength(2);
    const [w1Id, w2Id] = spawned as [string, string];

    const w1View = await client({ workerSessionId: w1Id });
    w1View.stop();
    await vi.waitFor(() => expect(w1View.getSnapshot().busy).toBe(false), { timeout: 10_000 });
    releaseW1();

    const { loadSavedSession: loadWorkerSession } = await import('../src/session-store.js');
    await vi.waitFor(
      () => {
        const done = loadWorkerSession(w2Id)?.entries.some((entry) => entry.kind === 'assistant' && entry.text === 'LEASE-DONE');
        expect(done).toBe(true);
      },
      { timeout: 15_000 },
    );
    const results = (loadWorkerSession(w2Id)?.entries ?? [])
      .filter((entry) => entry.kind === 'tool')
      .map((entry) => String((entry as { result?: unknown }).result ?? ''));
    const denied = results.find((result) => result.includes('Another running subagent'));
    expect(denied ?? '').toContain('shared.txt');
    expect(results.filter((result) => result.includes('"status": "completed"'))).toHaveLength(1);
  }, 20_000);
});
