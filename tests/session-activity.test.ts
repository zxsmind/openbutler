import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { MockLanguageModelV3 } from 'ai/test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEnvironment, AgentSessionController } from '../src/agent-session.js';
import type { AgentSessionClient } from '../src/agent-session.js';
import { ToolRegistry } from '../src/tools/registry.js';

type Store = typeof import('../src/session-store.js');

// A new chat the daemon only holds in memory: the web layer must order it by
// its birth, not by when a connection last touched it.
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
  previousDataDir = process.env.RANITE_DATA_DIR;
  dataDir = mkdtempSync(join(tmpdir(), 'ranite-session-activity-'));
  process.env.RANITE_DATA_DIR = dataDir;
  vi.resetModules();
  store = await import('../src/session-store.js');
});

afterEach(async () => {
  await controller?.close();
  controller = undefined;
  if (previousDataDir === undefined) delete process.env.RANITE_DATA_DIR;
  else process.env.RANITE_DATA_DIR = previousDataDir;
  if (dirname(resolve(dataDir)) !== resolve(tmpdir()) || !basename(dataDir).startsWith('ranite-session-activity-')) {
    throw new Error('Refusing to remove a directory outside this test fixture.');
  }
  rmSync(dataDir, { recursive: true, force: true });
});

describe('recent ordering reads content activity', () => {
  it('ignores a later file rewrite that carries no conversation activity', () => {
    const alpha = withUser(store, 'Alpha');
    const beta = withUser(store, 'Beta');
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

describe('web catalog orders unsaved chats by birth, not connection access', () => {
  it('keeps the summary identical across gets that touch connections', async () => {
    const bornAt = '2026-10-26T10:00:00.000Z';
    const defaultSession = { ...store.createSession('fixture', 'model-a'), createdAt: bornAt };
    const freshSession = { ...store.createSession('fixture', 'model-a'), createdAt: bornAt };

    const fakeClient = (session: typeof defaultSession) =>
      ({
        getSnapshot: () => ({ session, busy: false, runningTurnId: null, queuedMessageCount: 0 }),
        subscribe: () => () => {},
        close: async () => {},
        isBusy: false,
        runtime: { providerId: 'fixture', modelId: 'model-a' },
        listSessions: async () => [],
      }) as unknown as AgentSessionClient;

    const { connectDaemonSession } = await import('../src/daemon-client.js');
    vi.mocked(connectDaemonSession).mockResolvedValue(fakeClient(freshSession));

    const { WebSessions } = await import('../src/web/sessions.js');
    const web = new WebSessions(fakeClient(defaultSession), dataDir);
    try {
      const created = await web.create(null);
      const before = await web.list();
      await new Promise((finish) => setTimeout(finish, 25));
      // A get updates connection.touched; under the old scheme that alone
      // reshuffled every unsaved chat on the next reload.
      await web.get(created.getSnapshot().session.id);
      const after = await web.list();

      expect(after.map((entry) => [entry.id, entry.updatedAt, entry.lastActivityAt])).toEqual(
        before.map((entry) => [entry.id, entry.updatedAt, entry.lastActivityAt]),
      );
      const fresh = after.find((entry) => entry.id === freshSession.id)!;
      expect(fresh.updatedAt).toBe(bornAt);
      expect(fresh.lastActivityAt).toBe(bornAt);
    } finally {
      await web.close();
    }
  });
});
