import { toolEntryCommand } from '../src/tool-display.js';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

const daemonStart = vi.hoisted(() => ({ run: vi.fn(), runtimeOptions: vi.fn() }));
vi.mock('../src/daemon.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/daemon.js')>();
  return { ...actual, startDaemon: daemonStart.run };
});

const usage = {
  inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 20, text: 20, reasoning: 0 },
};
const preferences = { reasoningVariantId: 'default', showReasoning: false };
let root: string;
let host: DaemonHost;
let server: Server;
let clients: AgentSessionClient[];
let connect: (typeof import('../src/daemon-client.js'))['connectDaemonSession'];
let requestHost: (typeof import('../src/daemon.js'))['requestHost'];
let model: MockLanguageModelV3;
let registry: ToolRegistry;
let fixtureVision = false;
let fixtureSettingsReload: AgentEnvironment['reloadSettings'];
const registrySeen = new WeakSet<ToolRegistry>();
const sessionMessageSeen = new WeakSet<ToolRegistry>();
const subagentSeen = new WeakSet<ToolRegistry>();
const parentMessageSeen = new WeakSet<ToolRegistry>();
const subagentStopSeen = new WeakSet<ToolRegistry>();
const ownerMessageSendSeen = new WeakSet<ToolRegistry>();
const inboxSeen = new WeakSet<ToolRegistry>();

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
      daemonStart.runtimeOptions(options);
      const backgroundManage = options?.backgroundManage;
      if (options?.ownerMessageSend && !ownerMessageSendSeen.has(registry)) {
        const { createSendMessageToOwnerTool } = await import('../src/tools/owner-communication.js');
        registry.register(createSendMessageToOwnerTool(options.workspaceRoot ?? process.cwd(), options.ownerMessageSend));
        ownerMessageSendSeen.add(registry);
      }
      if (options?.inbox && !inboxSeen.has(registry)) {
        const { createInboxTool } = await import('../src/tools/inbox.js');
        registry.register(createInboxTool(options.inbox));
        inboxSeen.add(registry);
      }
      const sessionMessage = options?.sessionMessage;
      const subagent = options?.subagent;
      const parentMessage = options?.parentMessage;
      const subagentStop = options?.subagentStop;
      const workspaceRoot = options?.workspaceRoot ?? process.cwd();
      const { createScheduleTool } = await import('../src/tools/schedule.js');
      if (backgroundManage && !registrySeen.has(registry)) {
        registry.register(createScheduleTool(workspaceRoot, backgroundManage));
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
        supportsVision: fixtureVision,
        supportsImageToolResult: true,
        reasoningVariants: [],
        reasoningMetadataSource: null,
        reasoningSupport: 'model-unsupported',
        reasoningDefault: 'default',
        showReasoningDefault: false,
        saveReasoningPreference: () => {},
        saveShowReasoningPreference: () => {},
        getReasoningProviderOptions: () => ({}),
        getReviewProviderOptions: () => ({}),
        registry,
        selectModel: async () => {},
        ...(fixtureSettingsReload ? { reloadSettings: fixtureSettingsReload } : {}),
        close: async () => {},
      };
      return runtime;
    },
  });
}

beforeEach(async () => {
  fixtureSettingsReload = undefined;
  fixtureVision = false;
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
async function client(
  options: {
    chatSessionId?: string;
    newChatSession?: boolean;
    projectId?: string | null;
    clientKind?: 'web' | 'terminal';
    isolatedSession?: boolean;
    scheduleId?: string;
    workerSessionId?: string;
    runningWorkerOf?: string;
  } = {},
) {
  const result = await connect(root, options);
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
  it('runs independent web chats concurrently and stops only the addressed chat', async () => {
    const { createProject } = await import('../src/projects/store.js');
    const folderA = join(root, 'project-a');
    const folderB = join(root, 'project-b');
    mkdirSync(folderA);
    mkdirSync(folderB);
    const projectA = createProject({ name: 'Project A', folders: [folderA] });
    const projectB = createProject({ name: 'Project B', folders: [folderB] });
    model.doStream = async (options) => holdOpenWorkerStream(options.abortSignal);
    const a = await client({ clientKind: 'web', newChatSession: true, projectId: projectA.id });
    const b = await client({ clientKind: 'web', newChatSession: true, projectId: projectB.id });
    const aId = a.getSnapshot().session.id;
    const bId = b.getSnapshot().session.id;
    expect(aId).not.toBe(bId);
    await a.sendMessage({ text: 'Keep A running.', images: [] }, preferences);
    await b.sendMessage({ text: 'Keep B running.', images: [] }, preferences);
    await vi.waitFor(() => {
      expect(a.isBusy).toBe(true);
      expect(b.isBusy).toBe(true);
      expect(a.runtime.workspaceRoot).toBe(folderA);
      expect(b.runtime.workspaceRoot).toBe(folderB);
    });
    const aView = await client({ clientKind: 'web', chatSessionId: aId });
    expect(aView.getSnapshot().session.id).toBe(aId);
    expect(aView.isBusy).toBe(true);
    await expect(aView.createNewSession()).rejects.toThrow('attachment');
    aView.stop();
    await vi.waitFor(() => expect(a.isBusy).toBe(false));
    expect(b.isBusy, JSON.stringify(b.getSnapshot().session.entries)).toBe(true);
    expect(b.getSnapshot().session.id).toBe(bId);
    expect(b.getSnapshot().session.entries.some((entry) => entry.kind === 'user' && entry.text === 'Keep A running.')).toBe(false);
    await b.flushSave();
    const catalog = await b.listSessions();
    expect(catalog.find((session) => session.id === bId)?.running).toBe(true);
    b.stop();
    await vi.waitFor(() => expect(b.isBusy).toBe(false));
  });

  it('restores a closed rootless chat without changing the custodian conversation', async () => {
    const owner = await client();
    const hostMcp = daemonStart.runtimeOptions.mock.lastCall?.[0]?.mcpManager;
    expect(hostMcp).toBeDefined();
    const ownerId = owner.getSnapshot().session.id;
    await owner.sendMessage({ text: 'Keep the owner conversation.', images: [] }, preferences);
    await vi.waitFor(() => expect(owner.getSnapshot().session.entries.some((entry) => entry.kind === 'assistant')).toBe(true));
    await owner.flushSave();
    const opened = await client({ newChatSession: true, clientKind: 'web' });
    expect(daemonStart.runtimeOptions.mock.lastCall?.[0]?.mcpManager).toBe(hostMcp);
    const id = opened.getSnapshot().session.id;
    await opened.sendMessage({ text: 'Remember this conversation.', images: [] }, preferences);
    await vi.waitFor(() =>
      expect(
        opened.getSnapshot().session.entries.some((entry) => entry.kind === 'assistant'),
        JSON.stringify(opened.getSnapshot().session.entries),
      ).toBe(true),
    );
    await opened.flushSave();
    await replaceFixtureHost();
    const restored = await client({ chatSessionId: id, clientKind: 'web' });
    expect(daemonStart.runtimeOptions.mock.lastCall?.[0]?.mcpManager).toBeDefined();
    expect(restored.getSnapshot().session.id).toBe(id);
    expect(
      restored.getSnapshot().session.entries.some((entry) => entry.kind === 'user' && entry.text === 'Remember this conversation.'),
    ).toBe(true);
    const ownerAgain = await client();
    expect(ownerAgain.getSnapshot().session.id).toBe(ownerId);
  });
  it('consumes Team notifications on read while retaining the canonical DM history', async () => {
    const { TeamStore } = await import('../src/team/store.js');
    const { startTeamServer } = await import('../src/team/server.js');
    const { localChannel } = await import('../src/team/session.js');
    const { hashTicket, makeTicket } = await import('../src/team/service.js');
    const teamStore = new TeamStore(join(root, 'fixture-team.db'));
    const now = Date.now();
    teamStore.initHub('fixture-hub', 'fixture-team', 'Fixture', 'Hub', now);
    teamStore.createJoinRequest('jr_fixture', 'Reader', 'fixture-code', now);
    const ticket = makeTicket();
    teamStore.decideJoin('jr_fixture', true, ticket, hashTicket(ticket), now);
    teamStore.confirmTicket('jr_fixture');
    const teamServer = await startTeamServer({ store: teamStore, bindAddress: '127.0.0.1', port: 0, allowLoopback: true });
    const settings = await import('../src/settings.js');
    const store = settings.defaultSettings();
    store.team = {
      role: 'member',
      teamName: 'Fixture',
      memberName: 'Reader',
      hubHost: '127.0.0.1',
      hubPort: Number(new URL(teamServer.url).port),
      teamId: 'fixture-team',
    };
    settings.saveSettings(store);
    settings.saveSecrets({ providers: {}, teamTicket: ticket });
    try {
      await requestHost('settings.reload');
      const viewer = await client();
      await localChannel(teamStore, 'Hub').send('Reader', 'Read once; retain history.');
      const built = await registry.createModelTools({
        approve: async () => true,
        onResult: () => {},
        sessionId: viewer.getSnapshot().session.id,
      });
      const execute = async (action: 'list' | 'read', ids?: string[]) =>
        (await built.tools.inbox!.execute!(
          { action, source: 'Team', ...(ids ? { ids } : {}) },
          { toolCallId: 'team-read-fixture', messages: [] },
        )) as { items: Array<{ id: string; content?: { text?: string } }> };
      const pending = await execute('list');
      expect(pending.items).toHaveLength(1);
      expect((await execute('read', [pending.items[0]!.id])).items[0]?.content?.text).toBe('Read once; retain history.');
      expect((await execute('list')).items).toEqual([]);
      expect(teamStore.unreadDmCount('Reader')).toBe(0);
      expect((await localChannel(teamStore, 'Reader').history({ scope: 'dm', peer: 'Hub' })).messages[0]?.body).toBe(
        'Read once; retain history.',
      );
    } finally {
      delete store.team;
      settings.saveSettings(store);
      await requestHost('settings.reload');
      await teamServer.close();
      teamStore.close();
    }
  });

  it('consumes a Telegram notification on read across new chats and host restarts without requiring a reply', async () => {
    const settings = await import('../src/settings.js');
    expect(settings.getSettingsPath()).toBe(join(root, 'settings.yaml'));
    const store = settings.defaultSettings();
    store.telegram = { enabled: true, tokenEnv: 'UNSET_FIXTURE_INBOX_TOKEN', workspaceRoot: root, chatId: '42', userId: '7' };
    settings.saveSettings(store);
    let viewer = await client();
    await host.receiveTelegramMessage(9001, 'Retain this message as history.');
    type Event = { id: string; source: string; status: string; kind: string };
    await vi.waitFor(async () => {
      const events = (await requestHost('ledger.events')) as Event[];
      expect(events.some((event) => event.kind === 'inbox.wakeup' && event.status === 'delivered')).toBe(true);
    });
    const executeInbox = async (action: 'list' | 'read', ids?: string[]) => {
      const built = await registry.createModelTools({
        approve: async () => true,
        onResult: () => {},
        sessionId: viewer.getSnapshot().session.id,
      });
      return (await built.tools.inbox!.execute!(
        { action, source: 'Telegram', ...(ids ? { ids } : {}) },
        { toolCallId: 'fixture-inbox', messages: [] },
      )) as {
        items: Array<{ id: string; content?: { messages?: Array<{ text: string }> } }>;
      };
    };
    const listed = await executeInbox('list');
    expect(listed.items).toHaveLength(1);
    const id = listed.items[0]!.id;
    expect((await executeInbox('read', [id])).items[0]?.content?.messages?.[0]?.text).toBe('Retain this message as history.');
    expect((await executeInbox('list')).items).toEqual([]);
    await viewer.createNewSession();
    expect((await executeInbox('list')).items).toEqual([]);
    registry = new ToolRegistry();
    await replaceFixtureHost();
    viewer = await client();
    expect((await executeInbox('list')).items).toEqual([]);
    expect((await executeInbox('read', [id])).items[0]?.content?.messages?.[0]?.text).toBe('Retain this message as history.');
    expect((await executeInbox('list')).items).toEqual([]);
    const events = (await requestHost('ledger.events')) as Event[];
    expect(events.filter((event) => event.kind === 'inbox.wakeup')).toHaveLength(1);
    expect(events.some((event) => event.kind === 'inbox.delivery-recovery')).toBe(false);
  });

  it('only reminds unread Telegram notifications after five minutes, preserving the cooldown across restarts', async () => {
    const settings = await import('../src/settings.js');
    const store = settings.defaultSettings();
    store.telegram = { enabled: true, tokenEnv: 'UNSET_FIXTURE_REMINDER_TOKEN', workspaceRoot: root, chatId: '42', userId: '7' };
    settings.saveSettings(store);
    await client();
    await host.receiveTelegramMessage(9002, 'Unread reminder fixture.');
    type Event = { id: string; source: string; status: string; kind: string };
    await vi.waitFor(async () => {
      const events = (await requestHost('ledger.events')) as Event[];
      expect(events.some((event) => event.kind === 'inbox.wakeup' && event.status === 'delivered')).toBe(true);
    });
    const { ActivityLedger } = await import('../src/activity-ledger.js');
    const reader = new ActivityLedger(join(root, 'state.db'), { readOnly: true });
    const events = (await requestHost('ledger.events')) as Event[];
    const inboxId = events.find((event) => event.source === 'owner-inbox')!.id;
    const due = Number(reader.getState(`owner-inbox:remind:${inboxId}`));
    reader.close();
    expect(due - Date.now()).toBeGreaterThan(290_000);
    registry = new ToolRegistry();
    await replaceFixtureHost();
    expect(((await requestHost('ledger.events')) as Event[]).filter((event) => event.kind === 'inbox.wakeup')).toHaveLength(1);
    const clock = vi.spyOn(Date, 'now').mockReturnValue(due + 1);
    try {
      registry = new ToolRegistry();
      await replaceFixtureHost();
      await vi.waitFor(async () =>
        expect(((await requestHost('ledger.events')) as Event[]).filter((event) => event.kind === 'inbox.wakeup')).toHaveLength(2),
      );
    } finally {
      clock.mockRestore();
    }
  });

  it('reloads live runtimes after file saves and defers tool reloads while a session is busy', async () => {
    const reload = vi.fn(async (_tools?: boolean) => {});
    fixtureSettingsReload = reload;
    const viewer = await client();
    const settings = await import('../src/settings.js');
    expect(settings.getSettingsPath()).toBe(join(root, 'settings.yaml'));
    const store = settings.loadSettings();
    store.theme = 'Light';
    settings.saveSettings(store);
    await vi.waitFor(() => expect(reload).toHaveBeenCalledWith(true));
    model.doStream = async (options) => holdOpenWorkerStream(options.abortSignal);
    const running = viewer.sendMessage({ text: 'Keep this turn open.', images: [] }, preferences);
    await vi.waitFor(() => expect(viewer.getSnapshot().busy).toBe(true));
    reload.mockClear();
    store.theme = 'Dark';
    settings.saveSettings(store);
    await vi.waitFor(() => expect(reload).toHaveBeenCalledWith(false));
    expect(reload.mock.calls.some(([tools]) => tools === true)).toBe(false);
    viewer.stop();
    await running;
    await vi.waitFor(() => expect(reload).toHaveBeenCalledWith(true));
  });

  it('reloads live runtimes when another process replaces the model catalog', async () => {
    const reload = vi.fn(async (_tools?: boolean) => {});
    fixtureSettingsReload = reload;
    await client();
    for (const filename of ['catalog.ndjson', 'catalog-index.json']) {
      reload.mockClear();
      writeFileSync(join(root, filename), '{}');
      await vi.waitFor(() => expect(reload).toHaveBeenCalledWith(true));
    }
  });

  it('binds web and terminal source labels to the connection and persists them', async () => {
    const web = await client({ clientKind: 'web' });
    const terminal = await client();
    await web.sendMessage(
      {
        text: 'Browser message.',
        images: [],
        communication: { source: 'telegram', replyTo: { channel: 'telegram', chatId: 'fake' } },
      },
      preferences,
    );
    await vi.waitFor(() =>
      expect(web.getSnapshot().session.entries).toContainEqual(
        expect.objectContaining({
          kind: 'user',
          text: 'Browser message.',
          source: 'web',
          turnOutcome: 'completed',
        }),
      ),
    );
    expect(JSON.stringify(model.doStreamCalls[0]!.prompt)).toContain('[Host context: owner message via web]');
    expect(JSON.stringify(model.doStreamCalls[0]!.prompt)).not.toContain('owner message via Telegram');
    await terminal.sendMessage({ text: 'Terminal message.', images: [] }, preferences);
    await vi.waitFor(() =>
      expect(terminal.getSnapshot().session.entries).toContainEqual(
        expect.objectContaining({
          kind: 'user',
          text: 'Terminal message.',
          source: 'terminal',
          turnOutcome: 'completed',
        }),
      ),
    );
    expect(JSON.stringify(model.doStreamCalls[1]!.prompt.at(-1))).toContain('[Host context: owner message via terminal]');
    await web.flushSave();
    const { loadSavedSession } = await import('../src/session-store.js');
    expect(loadSavedSession(web.getSnapshot().session.id)!.entries).toContainEqual(
      expect.objectContaining({
        kind: 'user',
        text: 'Browser message.',
        source: 'web',
      }),
    );
  });

  it('preserves web identity through live-session switching and reconnecting', async () => {
    daemonStart.run.mockResolvedValue({ pid: 9001, startedAt: new Date().toISOString(), workspaceCount: 0, connectedClients: 0 });
    const terminal = await client();
    const web = await client({ clientKind: 'web' });
    const isolated = await client({ isolatedSession: true });
    const originalId = terminal.getSnapshot().session.id;
    await web.loadSession(isolated.getSnapshot().session.id);
    await web.sendMessage({ text: 'Web after switching.', images: [] }, preferences);
    await vi.waitFor(() =>
      expect(web.getSnapshot().session.entries).toContainEqual(
        expect.objectContaining({
          text: 'Web after switching.',
          source: 'web',
          turnOutcome: 'completed',
        }),
      ),
    );
    await web.loadSession(originalId);
    await web.sendMessage({ text: 'Web before reconnect.', images: [] }, preferences);
    await vi.waitFor(() =>
      expect(web.getSnapshot().session.entries).toContainEqual(
        expect.objectContaining({
          text: 'Web before reconnect.',
          source: 'web',
          turnOutcome: 'completed',
        }),
      ),
    );
    await web.flushSave();
    await requestHost('stop', { restart: true });
    await replaceFixtureHost();
    await vi.waitFor(
      () =>
        expect(
          web
            .getSnapshot()
            .session.entries.some((entry) => entry.kind === 'notice' && entry.text.includes('Reconnected to the Ranite host.')),
        ).toBe(true),
      { timeout: 5_000, interval: 25 },
    );
    await web.sendMessage({ text: 'Web after reconnect.', images: [] }, preferences);
    await vi.waitFor(() =>
      expect(web.getSnapshot().session.entries).toContainEqual(
        expect.objectContaining({
          text: 'Web after reconnect.',
          source: 'web',
          turnOutcome: 'completed',
        }),
      ),
    );
    expect(JSON.stringify(model.doStreamCalls.at(-1)!.prompt.at(-1))).toContain('owner message via web');
  }, 10_000);

  it('reads Telegram owner messages through the inbox tool and only sends replies through the explicit tool', async () => {
    const settings = await import('../src/settings.js');
    const store = settings.defaultSettings();
    store.telegram = { enabled: true, tokenEnv: 'FTG_REPLY_TOKEN', workspaceRoot: root, chatId: '42', userId: '7' };
    settings.saveSettings(store);
    vi.stubEnv('FTG_REPLY_TOKEN', '123456:fixture-reply-token-value-ok');
    const sent: string[] = [];
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
          expect(body.chat_id).toBe('42');
          sent.push(String(body.text));
          result = { message_id: sent.length };
        }
        return new Response(JSON.stringify({ ok: true, result }));
      }),
    );
    try {
      await requestHost('settings.reload');
      const viewer = await client();
      model.doStream = vi
        .fn()
        .mockImplementationOnce(async (options: { prompt?: unknown }) => {
          const prompt = JSON.stringify(options.prompt);
          expect(prompt).toContain('[Host context: inbox notification]');
          expect(prompt).not.toContain('Inspect this');
          expect(prompt).not.toContain('owner message via Telegram');
          return stream(
            [{ type: 'tool-call', toolCallId: 'read', toolName: 'inbox', input: JSON.stringify({ action: 'read', source: 'Telegram' }) }],
            'tool-calls',
          );
        })
        .mockImplementationOnce(async (options: { prompt?: unknown }) => {
          expect(JSON.stringify(options.prompt)).toContain('Inspect this');
          expect(JSON.stringify(options.prompt)).toContain('owner message via Telegram');
          return stream(
            [
              {
                type: 'tool-call',
                toolCallId: 'send',
                toolName: 'send_message_to_owner',
                input: JSON.stringify({ text: 'Explicit Telegram answer' }),
              },
            ],
            'tool-calls',
          );
        })
        .mockImplementationOnce(async () => textStream('This final text stays in the terminal.'));
      await host.receiveTelegramMessage(1001, 'Inspect this');
      type Event = { id: string; source: string; status: string; payload: Record<string, unknown> };
      await vi.waitFor(
        async () => {
          const events = (await requestHost('ledger.events')) as Event[];
          expect(events.some((event) => event.source === 'owner-inbox' && event.status === 'delivered')).toBe(true);
          expect(events.some((event) => event.source === 'notification' && event.status === 'delivered')).toBe(true);
        },
        { timeout: 8000 },
      );
      expect(sent).toEqual(['Explicit Telegram answer']);
      expect(sent).not.toContain('This final text stays in the terminal.');
      await vi.waitFor(() =>
        expect(
          viewer
            .getSnapshot()
            .session.entries.some((entry) => entry.kind === 'assistant' && entry.text === 'This final text stays in the terminal.'),
        ).toBe(true),
      );
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
    expect(isolated.getSnapshot().session.entries).toContainEqual(expect.objectContaining({ kind: 'assistant', text: 'Fixture response' }));
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
    expect(daemonStart.run).not.toHaveBeenCalled();
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
    expect(host.getStatus().schedules).toBe(0);
    const shared = await client();
    const sharedId = shared.getSnapshot().session.id;
    shared.addEntry({ kind: 'notice', text: 'Shared fixture session' });
    await vi.waitFor(() => expect(shared.getSnapshot().session.entries).toHaveLength(1));
    const isolated = await client({ isolatedSession: true });
    expect(isolated.getSnapshot().session.id).not.toBe(sharedId);
    const longAnswer = 'Large sample café naïve 👋 output\n'.repeat(4000);
    model.doStream = async () => textStream(longAnswer);
    await isolated.sendMessage({ text: 'Isolated fixture request', images: [] }, preferences);
    await vi.waitFor(() => {
      expect(isolated.getSnapshot().busy).toBe(false);
      expect(isolated.getSnapshot().session.entries.find((entry) => entry.kind === 'assistant')).toMatchObject({
        kind: 'assistant',
        text: longAnswer,
      });
    });
    expect(shared.getSnapshot().session.entries).toMatchObject([{ kind: 'notice', text: 'Shared fixture session' }]);
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

  it('hands a stamped thinking duration to the client instead of losing it in the patch', async () => {
    // The publish diff treated a duration-only change as a text append with an
    // empty delta, and the client rebuilt the entry from kind and text alone. The
    // server had the duration while the transcript kept a bare "Thought" label.
    registry.register({
      providerId: 'host',
      name: 'inspect',
      description: 'Fixture tool',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      effect: { change: 'none', data: 'local', network: 'none', reversible: 'full', outbound: 'model' },
      autoApprove: () => true,
      execute: async () => ({ status: 'completed', detail: 'Fixture result' }),
    });
    model.doStream = vi
      .fn()
      .mockImplementationOnce(async () =>
        stream(
          [
            { type: 'reasoning-start', id: 'reasoning' },
            { type: 'reasoning-delta', id: 'reasoning', delta: 'Think before the tool.' },
            { type: 'reasoning-end', id: 'reasoning' },
            { type: 'tool-call', toolCallId: 'inspect-duration', toolName: 'inspect', input: '{}' },
          ],
          'tool-calls',
        ),
      )
      .mockImplementationOnce(async () => textStream('Fixture complete.'));
    const viewer = await client();
    await viewer.sendMessage({ text: 'Inspect fixture', images: [] }, { reasoningVariantId: 'default', showReasoning: true });
    await vi.waitFor(() => expect(viewer.getSnapshot().busy).toBe(false));
    const blocks = viewer.getSnapshot().session.entries.filter((entry) => entry.kind === 'reasoning');
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ kind: 'reasoning', text: 'Think before the tool.' });
    expect((blocks[0] as { durationMs?: number }).durationMs).toEqual(expect.any(Number));
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
    const result = (await requestHost('schedule.manage', { input: { action: 'add', schedule: task }, workspaceRoot: root })) as {
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
    await requestHost('schedule.manage', { input: { action: 'add', schedule: task }, workspaceRoot: root });
    await requestHost('schedule.manage', { input: { action: 'run', scheduleId: task.id }, workspaceRoot: root });
    const taskClient = await client({ scheduleId: task.id });
    await vi.waitFor(() => expect(taskClient.getSnapshot().pendingApprovalId).toBeTruthy());
    expect(execute).not.toHaveBeenCalled();
    taskClient.approveToolCall('allow', taskClient.getSnapshot().pendingApprovalId!);
    await vi.waitFor(() =>
      expect(
        taskClient.getSnapshot().session.entries.some((entry) => entry.kind === 'assistant' && entry.text === 'Task fixture finished'),
      ).toBe(true),
    );
    const events = (await requestHost('ledger.events')) as Array<{ id: string; source: string; status: string }>;
    const triggered = events.find((event) => event.source === 'schedule:manual');
    const actions = (await requestHost('ledger.actions')) as Array<{ eventId: string; state: string }>;
    expect(actions).toContainEqual(expect.objectContaining({ eventId: triggered?.id, state: 'completed' }));
    expect(execute).toHaveBeenCalledTimes(1);
    expect(events.some((event) => event.source === 'notification' && event.status === 'delivered')).toBe(true);
  }, 10_000);

  it('wakes the origin session with a run-numbered turn and records durable runtime', async () => {
    model.doStream = vi.fn().mockImplementationOnce(async () => textStream('Origin run finished'));
    const origin = await client();
    const originId = origin.getSnapshot().session.id;
    const task = {
      id: 'wake-origin',
      name: 'Wake me here',
      enabled: true,
      workspaceRoot: root,
      originSessionId: originId,
      instruction: 'Say the report.',
      trigger: { adapter: 'manual', options: {} },
    };
    await requestHost('schedule.manage', { input: { action: 'add', schedule: task }, workspaceRoot: root });
    await requestHost('schedule.manage', { input: { action: 'run', scheduleId: task.id }, workspaceRoot: root });
    await vi.waitFor(() =>
      expect(origin.getSnapshot().session.entries.some((entry) => entry.kind === 'assistant' && entry.text === 'Origin run finished')).toBe(
        true,
      ),
    );
    const wake = origin
      .getSnapshot()
      .session.entries.flatMap((entry) => (entry.kind === 'user' ? [entry.text] : []))
      .find((text) => text.startsWith('Schedule "Wake me here"'))!;
    expect(wake).toContain('This is run #1. No previous run.');
    expect(wake).not.toContain('LATE:');
    expect(wake).toContain('Trigger facts (untrusted observations');
    const list = (await requestHost('schedule.manage', { input: { action: 'list' }, workspaceRoot: root })) as {
      schedules: Array<{ id: string; runtime: Record<string, unknown> }>;
    };
    expect(list.schedules.find((candidate) => candidate.id === task.id)?.runtime).toMatchObject({
      runCount: 1,
      lastResult: 'completed',
      lastReport: 'Origin run finished',
    });
    const log = (await requestHost('schedule.manage', { input: { action: 'log', scheduleId: task.id }, workspaceRoot: root })) as {
      runs: Array<{ kind: string; status: string }>;
    };
    expect(log.runs).toContainEqual(expect.objectContaining({ kind: 'schedule.requested', status: 'delivered' }));
  }, 10_000);

  it('marks a past one-shot as LATE on wake instead of skipping it', async () => {
    model.doStream = vi.fn().mockImplementationOnce(async () => textStream('Late report'));
    const origin = await client();
    const past = new Date(Date.now() - 3_600_000);
    const pad = (value: number) => String(value).padStart(2, '0');
    const local = `${past.getFullYear()}-${pad(past.getMonth() + 1)}-${pad(past.getDate())}T${pad(past.getHours())}:${pad(past.getMinutes())}`;
    const task = {
      id: 'late-once',
      name: 'Late once',
      enabled: true,
      workspaceRoot: root,
      originSessionId: origin.getSnapshot().session.id,
      instruction: 'Report briefly.',
      trigger: { adapter: 'at', options: { at: local } },
    };
    await requestHost('schedule.manage', { input: { action: 'add', schedule: task }, workspaceRoot: root });
    await vi.waitFor(() =>
      expect(origin.getSnapshot().session.entries.some((entry) => entry.kind === 'assistant' && entry.text === 'Late report')).toBe(true),
    );
    const wake = origin
      .getSnapshot()
      .session.entries.flatMap((entry) => (entry.kind === 'user' ? [entry.text] : []))
      .find((text) => text.startsWith('Schedule "Late once"'))!;
    expect(wake).toMatch(/LATE: scheduled for .* \(1h \d+m late\)/);
  }, 10_000);

  it('falls back to the task session with provenance when the origin session is gone', async () => {
    model.doStream = vi.fn().mockImplementationOnce(async () => textStream('Fallback finished'));
    const task = {
      id: 'wake-fallback',
      name: 'Fallen back',
      enabled: true,
      workspaceRoot: root,
      originSessionId: 'dead-beef-session',
      instruction: 'Say the report.',
      trigger: { adapter: 'manual', options: {} },
    };
    await requestHost('schedule.manage', { input: { action: 'add', schedule: task }, workspaceRoot: root });
    await requestHost('schedule.manage', { input: { action: 'run', scheduleId: task.id }, workspaceRoot: root });
    const taskClient = await client({ scheduleId: task.id });
    await vi.waitFor(() =>
      expect(
        taskClient.getSnapshot().session.entries.some((entry) => entry.kind === 'assistant' && entry.text === 'Fallback finished'),
      ).toBe(true),
    );
    const wake = taskClient
      .getSnapshot()
      .session.entries.flatMap((entry) => (entry.kind === 'user' ? [entry.text] : []))
      .find((text) => text.includes('Schedule "Fallen back"'))!;
    expect(wake.startsWith('Created in session dead-beef-session, which no longer exists.')).toBe(true);
    expect(wake).toContain('This is run #1. No previous run.');
  }, 10_000);

  it('defaults a tool-created task to the calling session for wake affinity', async () => {
    model.doStream = vi
      .fn()
      .mockImplementationOnce(async () =>
        stream(
          [
            {
              type: 'tool-call',
              toolCallId: 'bg-add',
              toolName: 'schedule',
              input: JSON.stringify({
                action: 'add',
                schedule: {
                  id: 'threaded',
                  name: 'Threaded',
                  enabled: true,
                  workspaceRoot: root,
                  instruction: 'Do the thing.',
                  trigger: { adapter: 'manual', options: {} },
                },
              }),
            },
          ],
          'tool-calls',
        ),
      )
      .mockImplementationOnce(async () => textStream('Task created'));
    const caller = await client();
    await caller.sendMessage({ text: 'Create a schedule', images: [] }, preferences);
    // Same-workspace task management runs silent: no approval card.
    await vi.waitFor(() =>
      expect(caller.getSnapshot().session.entries.some((entry) => entry.kind === 'assistant' && entry.text === 'Task created')).toBe(true),
    );
    expect(caller.getSnapshot().pendingApprovalId).toBeNull();
    const list = (await requestHost('schedule.manage', { input: { action: 'list' }, workspaceRoot: root })) as {
      schedules: Array<{ id: string; originSessionId: string }>;
    };
    expect(list.schedules.find((candidate) => candidate.id === 'threaded')?.originSessionId).toBe(caller.getSnapshot().session.id);
  }, 10_000);

  it('preserves an explicit separate schedule session and reuses it across runs and host restarts', async () => {
    const caller = await client();
    const callerId = caller.getSnapshot().session.id;
    const schedule = {
      id: 'separate-persistent',
      name: 'Separate persistent',
      enabled: true,
      workspaceRoot: root,
      originSessionId: '',
      instruction: 'Report the run.',
      trigger: { adapter: 'manual', options: {} },
    };
    const built = await registry.createModelTools({ approve: async () => true, onResult: () => {}, sessionId: callerId });
    await built.tools.schedule!.execute!({ action: 'add', schedule }, { toolCallId: 'add-separate', messages: [] });
    const settings = await import('../src/settings.js');
    expect(settings.getSettingsPath()).toBe(join(root, 'settings.yaml'));
    expect(settings.loadSettings().schedules.find((item) => item.id === schedule.id)?.originSessionId).toBe('');
    let scheduled = await client({ scheduleId: schedule.id });
    const scheduleSessionId = scheduled.getSnapshot().session.id;
    expect(scheduleSessionId).not.toBe(callerId);
    model.doStream = vi.fn(async () => textStream('Persistent schedule report.'));
    const run = async (number: number) => {
      await requestHost('schedule.manage', { input: { action: 'run', scheduleId: schedule.id }, workspaceRoot: root });
      await vi.waitFor(async () => {
        const result = (await requestHost('schedule.manage', { input: { action: 'list' }, workspaceRoot: root })) as {
          schedules: Array<{ id: string; runtime: { runCount: number; status: string } }>;
        };
        const state = result.schedules.find((item) => item.id === schedule.id)!.runtime;
        expect(state.runCount).toBe(number);
        expect(state.status).toBe('idle');
      });
      expect(scheduled.getSnapshot().session.id).toBe(scheduleSessionId);
      expect(
        scheduled.getSnapshot().session.entries.some((entry) => entry.kind === 'user' && entry.text.includes(`This is run #${number}.`)),
      ).toBe(true);
    };
    await run(1);
    await run(2);
    expect(caller.getSnapshot().session.entries.some((entry) => entry.kind === 'user' && entry.source === 'schedule')).toBe(false);
    registry = new ToolRegistry();
    await replaceFixtureHost();
    scheduled = await client({ scheduleId: schedule.id });
    await run(3);
    expect(
      scheduled.getSnapshot().session.entries.filter((entry) => entry.kind === 'assistant' && entry.text === 'Persistent schedule report.'),
    ).toHaveLength(3);
  }, 10_000);

  it.each(['', 'existing-origin'])('preserves the existing schedule affinity %j when a tool update omits it', async (originSessionId) => {
    const caller = await client();
    const schedule = {
      id: 'preserve-affinity',
      name: 'Preserve affinity',
      enabled: true,
      workspaceRoot: root,
      originSessionId,
      instruction: 'Original instruction.',
      trigger: { adapter: 'manual', options: {} },
    };
    await requestHost('schedule.manage', { input: { action: 'add', schedule }, workspaceRoot: root });
    const { originSessionId: _origin, ...updated } = schedule;
    const built = await registry.createModelTools({
      approve: async () => true,
      onResult: () => {},
      sessionId: caller.getSnapshot().session.id,
    });
    await built.tools.schedule!.execute!(
      { action: 'update', schedule: { ...updated, instruction: 'Updated instruction.' } },
      { toolCallId: 'update-affinity', messages: [] },
    );
    const settings = await import('../src/settings.js');
    const saved = settings.loadSettings().schedules.find((item) => item.id === schedule.id);
    expect(saved?.originSessionId).toBe(originSessionId);
    expect(saved?.instruction).toBe('Updated instruction.');
  });

  it('generates a task id when add omits it', async () => {
    const result = (await requestHost('schedule.manage', {
      input: {
        action: 'add',
        schedule: {
          name: 'Nightly DB Check!',
          enabled: true,
          workspaceRoot: root,
          instruction: 'Check and report.',
          trigger: { adapter: 'manual', options: {} },
        },
      },
      workspaceRoot: root,
    })) as { status: string; schedule: { id: string; name: string } };
    expect(result.status).toBe('completed');
    expect(result.schedule.id).toMatch(/^nightly-db-check-[0-9a-f]{4}$/);
    const list = (await requestHost('schedule.manage', { input: { action: 'list' }, workspaceRoot: root })) as {
      schedules: Array<{ id: string }>;
    };
    expect(list.schedules.map((task) => task.id)).toContain(result.schedule.id);
  });

  it('persists background worker lineage and notes to durable state when it finishes', async () => {
    let workerStep = 0;
    let spawns = 0;
    // Bounded by construction: snapshot sync lags a fast mock loop, so the
    // mock must terminate from its own counters, never from snapshots.
    model.doStream = vi.fn(async (options: { prompt?: unknown }) => {
      const serialized = JSON.stringify(options.prompt ?? []);
      if (serialized.includes('You are a worker session')) {
        workerStep += 1;
        if (workerStep === 1)
          return stream(
            [
              {
                type: 'tool-call',
                toolCallId: 'w-note',
                toolName: 'parent_message',
                input: JSON.stringify({ text: 'Milestone one done.' }),
              },
            ],
            'tool-calls',
          );
        return textStream('WORKER-REPORT: all done.');
      }
      spawns += 1;
      if (spawns >= 2) return textStream('PARENT-DONE');
      return stream(
        [
          {
            type: 'tool-call',
            toolCallId: `p-spawn-${spawns}`,
            toolName: 'subagent',
            input: JSON.stringify({ task: 'Do it.', mode: 'executor', background: true }),
          },
        ],
        'tool-calls',
      );
    });
    const viewerEntries = () => viewer.getSnapshot().session.entries as Array<{ kind: string; session?: unknown; result?: unknown }>;
    const viewer = await client();
    const parentId = viewer.getSnapshot().session.id;
    await viewer.sendMessage({ text: 'Spawn the worker.', images: [] }, preferences);
    await vi.waitFor(() =>
      expect(
        viewerEntries()
          .map((entry) => (entry.kind === 'tool' ? entry.session : undefined))
          .find((session): session is string => typeof session === 'string'),
      ).toBeTruthy(),
    );
    const workerId = viewerEntries()
      .map((entry) => (entry.kind === 'tool' ? entry.session : undefined))
      .find((session): session is string => typeof session === 'string')!;
    const workerView = await client({ workerSessionId: workerId });
    await vi.waitFor(() => expect(workerView.getSnapshot().busy).toBe(false), { timeout: 10_000 });
    // The durable artifacts a post-restart poll reads: lineage record plus notes.
    const { ActivityLedger } = await import('../src/activity-ledger.js');
    const { readWorkerOutbox, readWorkerRecord } = await import('../src/worker-records.js');
    const ledger = new ActivityLedger(join(root, 'state.db'), { readOnly: true });
    try {
      expect(readWorkerRecord(ledger, workerId)).toMatchObject({
        parentSessionId: parentId,
        mode: 'executor',
        background: true,
        finished: true,
      });
      expect(readWorkerOutbox(ledger, workerId).notes).toEqual(['Milestone one done.']);
    } finally {
      ledger.close();
    }
  }, 20_000);

  it('continues the workspace main session from Telegram so one thread spans both channels', async () => {
    const settings = await import('../src/settings.js');
    const store = settings.defaultSettings();
    store.telegram = { enabled: true, tokenEnv: 'FTG_TOKEN', workspaceRoot: root, chatId: '1', userId: '2' };
    settings.saveSettings(store);
    const viewer = await client();
    const mainId = viewer.getSnapshot().session.id;

    const prompts: string[] = [];
    model.doStream = vi
      .fn()
      .mockImplementationOnce(async () =>
        stream(
          [{ type: 'tool-call', toolCallId: 'read', toolName: 'inbox', input: JSON.stringify({ action: 'read', source: 'Telegram' }) }],
          'tool-calls',
        ),
      )
      .mockImplementation(async (options: { prompt?: unknown }) => {
        prompts.push(JSON.stringify(options.prompt));
        return textStream('Fixture response');
      });

    await host.receiveTelegramMessage(11, 'Hello from Telegram');

    await vi.waitFor(() =>
      expect(viewer.getSnapshot().session.entries.some((entry) => entry.kind === 'assistant' && entry.text === 'Fixture response')).toBe(
        true,
      ),
    );
    expect(viewer.getSnapshot().session.id).toBe(mainId);
    // The inbox wake signal joins the shared thread as a user entry…
    expect(viewer.getSnapshot().session.entries.some((entry) => entry.kind === 'user' && entry.source === 'inbox')).toBe(true);
    // …while the actual Telegram text only surfaces through an explicit inbox read.
    expect(prompts.some((prompt) => prompt.includes('Hello from Telegram') && prompt.includes('owner message via Telegram'))).toBe(true);
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

    await vi.waitFor(() =>
      expect(viewer.getSnapshot().session.entries.some((entry) => entry.kind === 'assistant' && entry.text === 'Fixture response')).toBe(
        true,
      ),
    );
    // The queued inbox message survives the stop: still present in the owner inbox ledger…
    type InboxEvent = { source: string; status: string; payload: { text?: unknown } };
    const events = (await requestHost('ledger.events')) as InboxEvent[];
    const inboxTexts = events.filter((event) => event.source === 'owner-inbox').map((event) => event.payload.text);
    expect(inboxTexts).toContain('First long request');
    expect(inboxTexts).toContain('Second queued request');
    // …and its wake still ran on the shared thread after the stop.
    expect(viewer.getSnapshot().session.entries.some((entry) => entry.kind === 'user' && entry.source === 'inbox')).toBe(true);
  }, 15_000);

  it('starts a new chat from Telegram with /clear', async () => {
    const settings = await import('../src/settings.js');
    const store = settings.defaultSettings();
    store.telegram = { enabled: true, tokenEnv: 'FTG_TOKEN', workspaceRoot: root, chatId: '1', userId: '2' };
    settings.saveSettings(store);
    const viewer = await client();
    const before = viewer.getSnapshot().session.id;
    await host.receiveTelegramMessage(31, '/clear');
    await vi.waitFor(() => expect(viewer.getSnapshot().session.id).not.toBe(before));
    expect(viewer.getSnapshot().busy).toBe(false);
  }, 10_000);

  it('lists the last 10 chats from Telegram with /sessions', async () => {
    const settings = await import('../src/settings.js');
    const store = settings.defaultSettings();
    store.telegram = { enabled: true, tokenEnv: 'FTG_SESSIONS_TOKEN', workspaceRoot: root, chatId: '1', userId: '2' };
    settings.saveSettings(store);
    vi.stubEnv('FTG_SESSIONS_TOKEN', '123456:fixture-sessions-token-ok');
    const sent: string[] = [];
    const fetchStub = vi.fn(async (url: unknown, init?: RequestInit) => {
      const method = String(url).split('/').at(-1);
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      let result: unknown = true;
      if (method === 'getMe') result = { is_bot: true, username: 'sessions_bot' };
      if (method === 'getWebhookInfo') result = {};
      if (method === 'sendMessage') {
        sent.push(String(body.text));
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
      const viewer = await client();
      await viewer.sendMessage({ text: 'Hello from the terminal', images: [] }, preferences);
      await vi.waitFor(() =>
        expect(viewer.getSnapshot().session.entries.some((entry) => entry.kind === 'assistant' && entry.text === 'Fixture response')).toBe(
          true,
        ),
      );
      await viewer.flushSave();
      await host.receiveTelegramMessage(41, '/sessions');
      await vi.waitFor(() => expect(sent.some((text) => /Recent chats:\n1\. .+ — \d{4}-\d{2}-\d{2}/.test(text))).toBe(true));
    } finally {
      vi.unstubAllGlobals();
    }
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
    expect(toolResult?.kind === 'tool' ? toolEntryCommand(toolResult) : '').toMatch(/^subagent explorer/);
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

  it('runs a background subagent and automatically wakes its idle parent for the final report', async () => {
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
            toolName: 'inbox',
            input: JSON.stringify({ action: 'read', ids: ['Subagent:' + workerIdFrom(serialized)] }),
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
      .session.entries.find(
        (entry) => entry.kind === 'tool' && toolEntryCommand(entry).startsWith('subagent ') && typeof entry.session === 'string',
      );
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
    expect(viewer.getSnapshot().session.entries.some((entry) => entry.kind === 'user' && entry.source === 'inbox')).toBe(true);
    // Once the parent has consumed the report, the completion must settle: a raw
    // signal check used to ignore the staged read and requeue a fresh empty wake
    // on every pump (815 claims observed on one event).
    await vi.waitFor(async () => {
      const events = (await requestHost('ledger.events')) as { kind: string; status: string }[];
      const completions = events.filter((entry) => entry.kind === 'worker.completed');
      expect(completions.length).toBeGreaterThan(0);
      expect(completions[completions.length - 1]!.status).toBe('delivered');
    });
    // Queued wakes carry a visible message; empty rows must never reach the queue.
    expect(viewer.getSnapshot().queuedMessages.every((message) => message.text.trim().length > 0)).toBe(true);
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
              toolName: 'inbox',
              input: JSON.stringify({ action: 'read', ids: ['Subagent:' + workerIdFrom(serialized)] }),
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
              toolName: 'inbox',
              input: JSON.stringify({ action: 'read', ids: ['Subagent:' + capturedWorkerId] }),
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
            toolName: 'inbox',
            input: JSON.stringify({ action: 'read', ids: ['Subagent:' + capturedWorkerId] }),
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
      .session.entries.find(
        (entry) => entry.kind === 'tool' && toolEntryCommand(entry).startsWith('subagent ') && typeof entry.session === 'string',
      );
    expect(spawnResult).toBeDefined();
    const stopResult = viewer
      .getSnapshot()
      .session.entries.find((entry) => entry.kind === 'tool' && toolEntryCommand(entry).startsWith('Stop '));
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
    const busy = toolEntries.find(
      (entry) => entry.kind === 'tool' && entry.session === undefined && toolEntryCommand(entry).startsWith('subagent '),
    );
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
      .session.entries.find(
        (entry) => entry.kind === 'tool' && toolEntryCommand(entry).startsWith('subagent ') && typeof entry.session === 'string',
      );
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

async function automaticWorkerFixture(options: { fail?: boolean; question?: boolean } = {}) {
  const viewer = await client();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let spawned = false;
  let noteSent = false;
  let questionHandled = false;
  let parentCalls = 0;
  model.doStream = vi.fn(async (input: { prompt?: unknown; abortSignal?: AbortSignal | null }) => {
    const serialized = JSON.stringify(input.prompt ?? []);
    if (serialized.includes('You are a worker session')) {
      if (options.question && !noteSent) {
        noteSent = true;
        return stream(
          [
            {
              type: 'tool-call',
              toolCallId: 'important-note',
              toolName: 'parent_message',
              input: JSON.stringify({ text: 'NEED_PARENT_DECISION', kind: 'question' }),
            },
          ],
          'tool-calls',
        );
      }
      await Promise.race([
        gate,
        new Promise<void>((resolve) => {
          if (input.abortSignal?.aborted) resolve();
          else input.abortSignal?.addEventListener('abort', () => resolve(), { once: true });
        }),
      ]);
      if (options.fail) throw new Error('WORKER_FAILURE_FIXTURE');
      return textStream('AUTOMATIC_WORKER_REPORT');
    }
    parentCalls++;
    if (parentCalls > 20) return textStream(`FIXTURE_STALLED: ${serialized.slice(-1800)}`);
    if (serialized.includes('AUTOMATIC_WORKER_REPORT')) return textStream('PARENT_RESULT_INTEGRATED');
    if (serialized.includes('WORKER_FAILURE_FIXTURE')) return textStream('PARENT_FAILURE_HANDLED');
    if (serialized.includes('NEED_PARENT_DECISION') && !questionHandled) {
      questionHandled = true;
      return textStream('PARENT_QUESTION_HANDLED');
    }
    if (!spawned) {
      spawned = true;
      return stream(
        [
          {
            type: 'tool-call',
            toolCallId: 'automatic-child',
            toolName: 'subagent',
            input: JSON.stringify({ task: 'Run a bounded background task.', mode: 'executor', background: true }),
          },
        ],
        'tool-calls',
      );
    }
    if (serialized.includes('[Host context: inbox notification]')) {
      expect(serialized).not.toContain('AUTOMATIC_WORKER_REPORT');
      const id = /\\?"session\\?":\s*\\?"([0-9a-f-]{36})\\?"/.exec(serialized)?.[1];
      return stream(
        [
          {
            type: 'tool-call',
            toolCallId: `read-worker-${parentCalls}`,
            toolName: 'inbox',
            input: JSON.stringify({ action: 'read', ids: ['Subagent:' + (id ?? 'missing')] }),
          },
        ],
        'tool-calls',
      );
    }
    return textStream('PARENT_READY');
  });
  await viewer.sendMessage({ text: 'Delegate and continue independently.', images: [] }, preferences);
  await vi.waitFor(() =>
    expect(
      viewer
        .getSnapshot()
        .session.entries.some((entry) => entry.kind === 'assistant' && ['PARENT_READY', 'PARENT_QUESTION_HANDLED'].includes(entry.text)),
    ).toBe(true),
  );
  const worker = viewer
    .getSnapshot()
    .session.entries.find((entry) => entry.kind === 'tool' && toolEntryCommand(entry).startsWith('subagent ') && entry.session);
  if (!worker || worker.kind !== 'tool' || !worker.session) throw new Error('Worker id was not returned');
  return { viewer, workerId: worker.session, release, parentCalls: () => parentCalls };
}

it('wakes the idle parent when its background worker fails', async () => {
  const { viewer, release } = await automaticWorkerFixture({ fail: true });
  release();
  await vi.waitFor(() =>
    expect(
      viewer.getSnapshot().session.entries.some((entry) => entry.kind === 'assistant' && entry.text === 'PARENT_FAILURE_HANDLED'),
    ).toBe(true),
  );
  expect(viewer.getSnapshot().session.entries.filter((entry) => entry.kind === 'user' && entry.source === 'inbox')).toHaveLength(1);
}, 20_000);

it('enforces parent and owner boundaries through the single inbox tool', async () => {
  const { workerId, release } = await automaticWorkerFixture();
  const executeAs = async (sessionId: string, input: Record<string, unknown>) => {
    const built = await registry.createModelTools({ sessionId, approve: async () => true, onResult: () => {} });
    return built.tools.inbox!.execute!(input, { toolCallId: 'inbox-boundary', messages: [] });
  };
  try {
    expect(await executeAs('another-parent', { action: 'list', source: 'Subagent' })).toMatchObject({ items: [] });
    expect(await executeAs('another-parent', { action: 'read', ids: [`Subagent:${workerId}`] })).toMatchObject({
      items: [{ content: { status: 'denied' } }],
    });
    expect(await executeAs(workerId, { action: 'read', ids: ['Telegram:any-id'] })).toMatchObject({
      status: 'partial',
      errors: [{ source: 'Telegram', error: expect.stringContaining('Workers may only read') }],
    });
    expect(await executeAs(workerId, { action: 'list', source: 'Team' })).toMatchObject({ items: [] });
  } finally {
    release();
  }
}, 20_000);

it('wakes the parent for a material question while the worker is still running', async () => {
  const { viewer, release } = await automaticWorkerFixture({ question: true });
  await vi.waitFor(() =>
    expect(
      viewer.getSnapshot().session.entries.some((entry) => entry.kind === 'assistant' && entry.text === 'PARENT_QUESTION_HANDLED'),
    ).toBe(true),
  );
  expect(viewer.getSnapshot().session.entries.some((entry) => entry.kind === 'tool' && entry.result.includes('NEED_PARENT_DECISION'))).toBe(
    true,
  );
  release();
  await vi.waitFor(() =>
    expect(
      viewer.getSnapshot().session.entries.some((entry) => entry.kind === 'assistant' && entry.text === 'PARENT_RESULT_INTEGRATED'),
    ).toBe(true),
  );
}, 20_000);

it('retains a completion across owner pause and host restart, then wakes only its original parent on resume', async () => {
  const { viewer, release, workerId, parentCalls } = await automaticWorkerFixture();
  const parentId = viewer.getSnapshot().session.id;
  viewer.stop({ holdQueue: true });
  await vi.waitFor(() => expect(viewer.getSnapshot().session.automaticWakeHeld).toBe(true));
  const calls = parentCalls();
  release();
  const { ActivityLedger } = await import('../src/activity-ledger.js');
  const { readWorkerRecord } = await import('../src/worker-records.js');
  await vi.waitFor(() => {
    const reader = new ActivityLedger(join(root, 'state.db'), { readOnly: true });
    try {
      expect(readWorkerRecord(reader, workerId)?.finished).toBe(true);
      expect(reader.pendingEvents().some((event) => event.source === 'worker')).toBe(true);
    } finally {
      reader.close();
    }
  });
  expect(parentCalls()).toBe(calls);
  await Promise.all(clients.map((entry) => entry.close()));
  clients = [];
  await host.close();
  registry = new ToolRegistry();
  host = await createFixtureHost();
  await host.start();
  const resumed = await client();
  expect(resumed.getSnapshot().session.id).toBe(parentId);
  expect(resumed.getSnapshot().session.automaticWakeHeld).toBe(true);
  expect(resumed.getSnapshot().session.entries.some((entry) => entry.kind === 'user' && entry.source === 'inbox')).toBe(false);
  await resumed.sendMessage({ text: 'Resume my work.', images: [] }, preferences);
  await vi.waitFor(() =>
    expect(
      resumed.getSnapshot().session.entries.some((entry) => entry.kind === 'assistant' && entry.text === 'PARENT_RESULT_INTEGRATED'),
    ).toBe(true),
  );
  expect(resumed.getSnapshot().session.entries.filter((entry) => entry.kind === 'user' && entry.source === 'inbox')).toHaveLength(1);
}, 20_000);

it('reconciles a saved poll after a crash before its ledger receipt without waking the parent twice', async () => {
  const { viewer, release, workerId, parentCalls } = await automaticWorkerFixture();
  release();
  await vi.waitFor(() =>
    expect(
      viewer.getSnapshot().session.entries.some((entry) => entry.kind === 'assistant' && entry.text === 'PARENT_RESULT_INTEGRATED'),
    ).toBe(true),
  );
  const { ActivityLedger } = await import('../src/activity-ledger.js');
  const { readWorkerRecord, writeWorkerRecord } = await import('../src/worker-records.js');
  const writer = new ActivityLedger(join(root, 'state.db'));
  try {
    await vi.waitFor(() => expect(readWorkerRecord(writer, workerId)?.reportedRevision).toBe(1));
    writeWorkerRecord(writer, workerId, { ...readWorkerRecord(writer, workerId)!, reportedRevision: 0 });
    const event = writer.listEvents().find((entry) => entry.source === 'worker' && entry.payload.workerId === workerId)!;
    writer.setEventState(event.id, 'pending');
  } finally {
    writer.close();
  }
  const calls = parentCalls();
  await Promise.all(clients.map((entry) => entry.close()));
  clients = [];
  await host.close();
  registry = new ToolRegistry();
  host = await createFixtureHost();
  await host.start();
  const reader = new ActivityLedger(join(root, 'state.db'), { readOnly: true });
  try {
    await vi.waitFor(() => expect(readWorkerRecord(reader, workerId)?.reportedRevision).toBe(1));
  } finally {
    reader.close();
  }
  const reconnected = await client();
  expect(parentCalls()).toBe(calls);
  expect(reconnected.getSnapshot().session.entries.filter((entry) => entry.kind === 'user' && entry.source === 'inbox')).toHaveLength(1);
}, 20_000);

it.each(['terminal', 'telegram'])(
  'keeps %s images in the session folder until the agent explicitly opens them',
  async (channel) => {
    fixtureVision = true;
    const { createReadTool } = await import('../src/tools/file-read.js');
    registry.register(createReadTool(['image'], root));
    if (channel === 'telegram') {
      const settings = await import('../src/settings.js');
      const store = settings.defaultSettings();
      store.telegram = { enabled: true, tokenEnv: 'ATTACHMENT_TEST_TOKEN_NOT_CONFIGURED', workspaceRoot: root, chatId: '1', userId: '2' };
      settings.saveSettings(store);
    }
    const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6C9sAAAAASUVORK5CYII=', 'base64');
    const viewer = await client();
    const sessionId = viewer.getSnapshot().session.id;
    let requestedRead = false;
    let filePath = '';
    model.doStream = vi.fn(
      async (options: { prompt?: Array<{ role: string; content: string | Array<{ type: string; text?: string; data?: unknown }> }> }) => {
        const messages = options.prompt ?? [];
        const files = messages.flatMap((message) =>
          Array.isArray(message.content) ? message.content.filter((part) => part.type === 'file') : [],
        );
        if (requestedRead) {
          if (files.length) expect(Buffer.from(files[0]!.data as Uint8Array)).toEqual(bytes);
          else expect(JSON.stringify(messages)).toContain(bytes.toString('base64'));
          return textStream('IMAGE_WAS_OPENED');
        }
        expect(files).toHaveLength(0);
        expect(JSON.stringify(messages)).not.toContain(bytes.toString('base64'));
        const lines = messages
          .filter((message) => message.role === 'user')
          .flatMap((message) =>
            typeof message.content === 'string'
              ? [message.content]
              : message.content.flatMap((part) => (part.type === 'text' ? [part.text ?? ''] : [])),
          )
          .flatMap((text) => text.split('\n'));
        const mapping = lines.find((line) => line.startsWith('[image#1='));
        if (!mapping)
          return stream(
            [
              {
                type: 'tool-call',
                toolCallId: 'read-notification',
                toolName: 'inbox',
                input: JSON.stringify({ action: 'read', source: 'Telegram' }),
              },
            ],
            'tool-calls',
          );
        filePath = JSON.parse(mapping.slice('[image#1='.length, -1)) as string;
        expect(dirname(filePath)).toBe(join(root, 'sessions', sessionId, 'attachments'));
        requestedRead = true;
        return stream(
          [{ type: 'tool-call', toolCallId: 'open-image', toolName: 'file_read', input: JSON.stringify({ path: filePath }) }],
          'tool-calls',
        );
      },
    );
    if (channel === 'terminal')
      await viewer.sendMessage(
        { text: '[image#1] Inspect this reference.', images: [{ base64: bytes.toString('base64'), mediaType: 'image/png' }] },
        preferences,
      );
    else
      await host.receiveTelegramMessage(999, '[image#1] Inspect this reference.', {
        image: { bytes, filename: 'reference.png', mediaType: 'image/png' },
      });
    await vi.waitFor(() =>
      expect(viewer.getSnapshot().session.entries.some((entry) => entry.kind === 'assistant' && entry.text === 'IMAGE_WAS_OPENED')).toBe(
        true,
      ),
    );
    expect(readFileSync(filePath)).toEqual(bytes);
    await viewer.flushSave();
    expect(existsSync(join(root, 'sessions', sessionId, `${sessionId}.json`))).toBe(true);
    expect(existsSync(join(root, 'attachments'))).toBe(false);
    if (channel === 'telegram') {
      const events = (await requestHost('ledger.events')) as Array<{ id: string; source: string }>;
      const event = events.find((item) => item.source === 'owner-inbox')!;
      const tools = await registry.createModelTools({ sessionId, approve: async () => true, onResult: () => {} });
      await tools.tools.inbox!.execute!({ action: 'acknowledge', ids: [`Telegram:${event.id}`] }, { toolCallId: 'handled', messages: [] });
      expect(existsSync(filePath)).toBe(true);
    }
  },
  20_000,
);
