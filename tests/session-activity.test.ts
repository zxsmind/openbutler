import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { MockLanguageModelV3 } from 'ai/test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEnvironment, AgentSessionController } from '../src/agent-session.js';
import type { AgentSessionClient } from '../src/agent-session.js';
import { ToolRegistry } from '../src/tools/registry.js';

type Store = typeof import('../src/session-store.js');

// A new chat the daemon only holds in memory: the store is the only catalog,
// so the web layer must show nothing for it until a message has been saved.
vi.mock('../src/daemon-client.js', () => ({ connectDaemonSession: vi.fn() }));

function runtimeFor(model: MockLanguageModelV3): AgentEnvironment {
  return {
    model,
    workspaceRoot: process.cwd(),
    modelName: 'Local fixture',
    providerId: 'fixture',
    modelId: 'model-a',
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
    registry: new ToolRegistry(),
    selectModel: async () => {},
    close: async () => {},
  };
}

function withUser(store: Store, text: string) {
  const session = store.createSession('fixture', 'model-a');
  return { ...session, entries: [{ kind: 'user' as const, text }] };
}

let dataDir: string;
let previousDataDir: string | undefined;
let store: Store;
let controller: AgentSessionController | undefined;

beforeEach(async () => {
  previousDataDir = process.env.OPENBUTLER_DATA_DIR;
  dataDir = mkdtempSync(join(tmpdir(), 'openbutler-session-activity-'));
  process.env.OPENBUTLER_DATA_DIR = dataDir;
  vi.resetModules();
  store = await import('../src/session-store.js');
});

afterEach(async () => {
  await controller?.close();
  controller = undefined;
  if (previousDataDir === undefined) delete process.env.OPENBUTLER_DATA_DIR;
  else process.env.OPENBUTLER_DATA_DIR = previousDataDir;
  if (dirname(resolve(dataDir)) !== resolve(tmpdir()) || !basename(dataDir).startsWith('openbutler-session-activity-')) {
    throw new Error('Refusing to remove a directory outside this test fixture.');
  }
  rmSync(dataDir, { recursive: true, force: true });
});

describe('recent ordering reads content activity', () => {
  it('ignores a later file rewrite that carries no conversation activity', () => {
    // Explicit stamps: two sessions born in the same millisecond would fall to
    // the id tiebreak and make the expected order a coin flip.
    const alpha = { ...withUser(store, 'Alpha'), lastActivityAt: '2026-10-27T10:00:00.000Z' };
    const beta = { ...withUser(store, 'Beta'), lastActivityAt: '2026-10-27T10:00:01.000Z' };
    store.saveSession(alpha);
    store.saveSession(beta);

    // Rewrite alpha's file so its updatedAt becomes the newest stamp while its
    // activity stamp stays put: file mechanics must not move the chat.
    const reloaded = store.loadSavedSession(alpha.id)!;
    store.saveSession({ ...reloaded, entries: [...reloaded.entries, { kind: 'user', text: 'again' }] });

    const listed = store.listSavedSessions();
    expect(listed.map((session) => session.id)).toEqual([beta.id, alpha.id]);
    expect(listed[0]!.lastActivityAt).toBe(beta.lastActivityAt);
    expect(listed[1]!.lastActivityAt).toBe(alpha.lastActivityAt);
  });

  it('falls back to updatedAt for sessions saved before the field existed', () => {
    const alpha = withUser(store, 'Alpha');
    store.saveSession(alpha);
    const legacy = withUser(store, 'Legacy');
    delete legacy.lastActivityAt;
    store.saveSession(legacy);

    const listed = store.listSavedSessions();
    expect(listed[0]!.id).toBe(legacy.id);
    expect(listed[0]!.lastActivityAt).toBeUndefined();
    expect(listed[0]!.updatedAt).toBe(listed[0]!.updatedAt);
  });

  it('breaks equal activity stamps deterministically by id', () => {
    const alpha = withUser(store, 'Alpha');
    const beta = withUser(store, 'Beta');
    store.saveSession(alpha);
    store.saveSession(beta);
    const shared = new Date('2026-10-27T00:00:00.000Z').toISOString();
    for (const id of [alpha.id, beta.id]) {
      const file = store.listSessionFiles().find((entry) => entry.id === id)!;
      const parsed = JSON.parse(readFileSync(file.path, 'utf8')) as Record<string, unknown>;
      parsed.lastActivityAt = shared;
      writeFileSync(file.path, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
    }

    const ids = store.listSavedSessions().map((session) => session.id);
    const ordered = [alpha.id, beta.id].sort((left, right) => left.localeCompare(right));
    expect(ids.filter((id) => id === ordered[0] || id === ordered[1])).toEqual(ordered);
  });

  it('reopening a conversation does not rewrite its file, content changes still do', async () => {
    const { AgentSessionController } = await import('../src/agent-session.js');
    const model = new MockLanguageModelV3({ modelId: 'model-a', doStream: async () => Promise.reject(new Error('unused')) });
    controller = new AgentSessionController(runtimeFor(model));
    controller.addEntry({ kind: 'user', text: 'hello' });
    controller.flushSave();

    const file = store.listSessionFiles().find((entry) => entry.id === controller!.getSnapshot().session.id)!;
    const before = readFileSync(file.path, 'utf8');
    const activityBefore = store.readSessionHeader(file.path, file.id)!.lastActivityAt;

    // Pure navigation: load the same conversation back through openSession.
    const loaded = store.loadSavedSession(file.id)!;
    controller.openSession(loaded);
    expect(readFileSync(file.path, 'utf8')).toBe(before);

    // Real content: a new message must persist and move the activity stamp.
    controller.addEntry({ kind: 'user', text: 'second' });
    controller.flushSave();
    const after = readFileSync(file.path, 'utf8');
    expect(after).not.toBe(before);
    expect(store.readSessionHeader(file.path, file.id)!.lastActivityAt! >= (activityBefore ?? '')).toBe(true);
  });
});

describe('a chat without a message is not a store file', () => {
  it('creation and project selection write nothing until the first message lands', async () => {
    const { AgentSessionController } = await import('../src/agent-session.js');
    const model = new MockLanguageModelV3({ modelId: 'model-a', doStream: async () => Promise.reject(new Error('unused')) });
    controller = new AgentSessionController(runtimeFor(model));
    const id = controller.getSnapshot().session.id;

    // Picking a project on the fresh chat must not create the file either.
    controller.selectProject(null, id);
    controller.createNewSession(null);
    expect(store.listSessionFiles()).toHaveLength(0);
    expect(store.listSavedSessions()).toEqual([]);

    // The first message is what brings the chat into existence.
    controller.addEntry({ kind: 'user', text: 'first' });
    controller.flushSave();
    const files = store.listSessionFiles();
    expect(files).toHaveLength(1);
    expect(store.readSessionHeader(files[0]!.path, files[0]!.id)).toMatchObject({ hasUserMessage: true });
  });
});

describe('web catalog lists only chats the store knows', () => {
  const fakeClient = (session: ReturnType<Store['createSession']>, busy = false) =>
    ({
      getSnapshot: () => ({ session, busy, runningTurnId: null, queuedMessageCount: 0 }),
      subscribe: () => () => {},
      close: async () => {},
      isBusy: busy,
      runtime: { providerId: session.providerId, modelId: session.modelId },
      listSessions: async () => [],
    }) as unknown as AgentSessionClient;

  it('leaves a live but unsaved chat out of the list, across gets that touch connections', async () => {
    const bornAt = '2026-10-26T10:00:00.000Z';
    const defaultSession = { ...store.createSession('fixture', 'model-a'), createdAt: bornAt };
    const freshSession = { ...store.createSession('fixture', 'model-a'), createdAt: bornAt };

    const { connectDaemonSession } = await import('../src/daemon-client.js');
    vi.mocked(connectDaemonSession).mockResolvedValue(fakeClient(freshSession));

    const { WebSessions } = await import('../src/web/sessions.js');
    const web = new WebSessions(fakeClient(defaultSession), dataDir);
    try {
      await web.create(null);
      const before = await web.list();
      await new Promise((finish) => setTimeout(finish, 25));
      await web.get(freshSession.id);
      const after = await web.list();

      // No store record, no row: a draft chat is not part of the catalog.
      expect(after.map((entry) => entry.id)).toEqual([]);
      expect(after.map((entry) => entry.id)).toEqual(before.map((entry) => entry.id));
    } finally {
      await web.close();
    }
  });

  it('overlays live title and running state onto a store-listed chat without reordering it', async () => {
    const saved = store.saveSession({ ...withUser(store, 'Saved title'), lastActivityAt: '2026-10-26T09:00:00.000Z' });
    const summary = store.listSavedSessions()[0]!;
    const live = { ...store.loadSavedSession(saved.id)!, title: 'Live title' };
    const listSessions = vi.fn(async () => [summary]);

    const { WebSessions } = await import('../src/web/sessions.js');
    // The default client is the live connection to the saved chat: its own
    // snapshot carries the fresher title and the running flag.
    const web = new WebSessions({ ...fakeClient(live, true), listSessions } as unknown as AgentSessionClient, dataDir);
    try {
      const listed = await web.list();

      expect(listed).toHaveLength(1);
      expect(listed[0]).toMatchObject({
        id: saved.id,
        title: 'Live title',
        running: true,
        lastActivityAt: '2026-10-26T09:00:00.000Z',
      });
    } finally {
      await web.close();
    }
  });
});
