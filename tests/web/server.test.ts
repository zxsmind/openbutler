import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startWebServer, type WebServer } from '../../src/web/server.js';
import type { AgentSessionClient, AgentSessionSnapshot } from '../../src/agent-session.js';
import type { SessionEntry } from '../../src/session-store.js';

vi.mock('../../src/daemon-client.js', () => ({ connectDaemonSession: async () => client }));
const settingsMocks = vi.hoisted(() => ({ saveSettings: vi.fn() }));
vi.mock('../../src/settings.js', () => ({
  loadSettings: () => ({
    providers: {
      local: { enabled: true, keys: ['private-key-never-exposed'], models: ['model-a', 'model-b'] },
      disabled: { enabled: false, keys: [], models: ['hidden-model'] },
    },
    providerOrder: ['local', 'disabled'],
  }),
  saveSettings: settingsMocks.saveSettings,
}));

let snapshot: AgentSessionSnapshot;
const localNotices = new Set<SessionEntry>();
const listeners = new Set<() => void>();
const publish = () => {
  for (const listener of listeners) listener();
};
const loadSession = vi.fn(async (id: string) => {
  snapshot = { ...snapshot, session: { ...snapshot.session, id, title: id, entries: [{ kind: 'user', text: id }] } };
  publish();
  return snapshot.session;
});
const newSession = vi.fn(async () => {
  snapshot = { ...snapshot, session: { ...snapshot.session, id: 'new-session', title: 'New chat', entries: [] } };
  publish();
});
const send = vi.fn(async () => undefined);
const client = {
  runtime: {
    modelName: 'Model A',
    providerId: 'local',
    modelId: 'model-a',
    workspaceRoot: 'C:/workspace',
    approvalMode: 'workspace',
    reasoningVariants: [
      { id: 'default', label: 'Default' },
      { id: 'high', label: 'High' },
    ],
    reasoningDefault: 'default',
  },
  get isBusy() {
    return snapshot.busy;
  },
  getSnapshot: () => snapshot,
  // The merged view carries this client's own notices; index-addressed callers
  // read the host entries only.
  getServerEntries: () => snapshot.session.entries.filter((entry) => !localNotices.has(entry)),
  subscribe: (listener: () => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  listSessions: async () => [
    { id: 'session-a', title: 'A' },
    { id: 'session-b', title: 'B' },
  ],
  loadSession,
  createNewSession: newSession,
  sendMessage: send,
  selectModel: vi.fn(async (providerId: string, modelId: string) => {
    Object.assign(client.runtime, { providerId, modelId });
    publish();
  }),
  close: vi.fn(),
} as unknown as AgentSessionClient;
let server: WebServer;
let cookie: string;
const post = (path: string, body: unknown) =>
  fetch(`${server.url}${path}`, {
    method: 'POST',
    headers: { cookie, origin: server.url, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

beforeEach(async () => {
  vi.clearAllMocks();
  listeners.clear();
  snapshot = {
    session: { id: 'session-a', title: 'A', entries: [{ kind: 'user', text: 'A' }] },
    busy: false,
    queuedMessageCount: 0,
  } as AgentSessionSnapshot;
  Object.assign(client.runtime, { providerId: 'local', modelId: 'model-a' });
  server = await startWebServer({ workspaceRoot: 'C:/workspace', port: 0, assetsDir: 'missing-test-assets' });
  const paired = await fetch(server.pairUrl, { redirect: 'manual' });
  cookie = paired.headers.get('set-cookie')!.split(';')[0];
});
afterEach(async () => {
  await server?.close();
});

describe('browser session controls', () => {
  it('requires pairing and rejects cross-origin mutations', async () => {
    expect((await fetch(`${server.url}/api/sessions`)).status).toBe(401);
    const result = await fetch(`${server.url}/api/session`, {
      method: 'POST',
      headers: { cookie, origin: 'https://other.example', 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'new', currentSessionId: 'session-a' }),
    });
    expect(result.status).toBe(403);
    expect(newSession).not.toHaveBeenCalled();
  });
  it('opens only a listed chat and returns a clean reset even at the same length', async () => {
    const response = await post('/api/session', { action: 'load', sessionId: 'session-b', currentSessionId: 'session-a' });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ reset: true, from: 0, session: { id: 'session-b' }, entries: [{ text: 'session-b' }] });
    expect((await post('/api/session', { action: 'load', sessionId: 'outside-workspace', currentSessionId: 'session-b' })).status).toBe(
      404,
    );
  });
  it('publishes a reset over the live stream when chats have the same entry count', async () => {
    const response = await fetch(`${server.url}/api/events`, { headers: { cookie } });
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const event = async () => {
      while (true) {
        const end = buffer.indexOf('\n\n');
        if (end >= 0) {
          const frame = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          if (frame.startsWith('event:')) return frame;
          continue;
        }
        const chunk = await reader.read();
        if (chunk.done) throw new Error('Stream ended before the snapshot.');
        buffer += decoder.decode(chunk.value, { stream: true });
      }
    };
    try {
      expect(await event()).toContain('event: snapshot');
      await post('/api/session', { action: 'load', sessionId: 'session-b', currentSessionId: 'session-a' });
      const switched = await event();
      expect(switched).toContain('event: snapshot');
      expect(switched).toContain('"id":"session-b"');
    } finally {
      await reader.cancel();
    }
  });
  it('preserves the current chat when busy, queued, or a stale browser tries navigation', async () => {
    snapshot.busy = true;
    expect((await post('/api/session', { action: 'new', currentSessionId: 'session-a' })).status).toBe(409);
    snapshot.busy = false;
    snapshot.queuedMessageCount = 1;
    expect((await post('/api/session', { action: 'new', currentSessionId: 'session-a' })).status).toBe(409);
    snapshot.queuedMessageCount = 0;
    expect((await post('/api/session', { action: 'new', currentSessionId: 'stale-chat' })).status).toBe(409);
    expect(newSession).not.toHaveBeenCalled();
  });
  it('creates an empty chat without sending anything to a model', async () => {
    const response = await post('/api/session', { action: 'new', currentSessionId: 'session-a' });
    expect(await response.json()).toMatchObject({ reset: true, session: { id: 'new-session' }, entries: [] });
    expect(send).not.toHaveBeenCalled();
  });
  it('does not send or load history into the wrong chat', async () => {
    expect((await post('/api/message', { text: 'Keep my draft', sessionId: 'old-chat' })).status).toBe(409);
    expect(send).not.toHaveBeenCalled();
    expect((await fetch(`${server.url}/api/entries?before=1&sessionId=old-chat`, { headers: { cookie } })).status).toBe(409);
    expect((await post('/api/message', { text: 'Hello', sessionId: 'session-a' })).status).toBe(200);
    expect(send).toHaveBeenCalledWith({ text: 'Hello', images: [] }, expect.anything());
  });
  it('accepts validated image attachments and a supported reasoning level without altering the message', async () => {
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9KsAAAAASUVORK5CYII=';
    const images = [{ base64: png, mediaType: 'image/png' }];
    expect((await post('/api/message', { text: '', images, reasoningVariantId: 'high', sessionId: 'session-a' })).status).toBe(200);
    expect(send).toHaveBeenCalledWith({ text: '', images }, { reasoningVariantId: 'high', showReasoning: undefined });
    send.mockClear();
    expect(
      (await post('/api/message', { text: 'test', images: [{ base64: 'not-an-image', mediaType: 'image/png' }], sessionId: 'session-a' }))
        .status,
    ).toBe(400);
    expect((await post('/api/message', { text: 'test', reasoningVariantId: 'not-supported', sessionId: 'session-a' })).status).toBe(400);
    expect(send).not.toHaveBeenCalled();
  });
  it('answers a send without waiting for the run it started', async () => {
    let release!: () => void;
    const running = new Promise<void>((resolve) => {
      release = resolve;
    });
    send.mockImplementationOnce(async () => {
      await running;
      return undefined;
    });
    const started = Date.now();
    const response = await post('/api/message', { text: 'long task', sessionId: 'session-a' });
    const elapsed = Date.now() - started;
    expect(response.status).toBe(200);
    // A phone browser abandons a request that stays open for the whole turn.
    expect(elapsed).toBeLessThan(1000);
    release();
    await running;
  });
  it('lists configured models without credentials and accepts only configured choices', async () => {
    const models = await (await fetch(`${server.url}/api/models`, { headers: { cookie } })).json();
    expect(models).toHaveLength(2);
    expect(models).toEqual([expect.objectContaining({ providerId: 'local', modelId: 'model-a', name: 'model-a' }), expect.any(Object)]);
    expect(JSON.stringify(models)).not.toContain('private-key');
    expect(JSON.stringify(models)).not.toContain('hidden-model');
    expect((await post('/api/model', { providerId: 'local', modelId: 'not-configured', sessionId: 'session-a' })).status).toBe(400);
    expect((await post('/api/model', { providerId: 'local', modelId: 'model-b', sessionId: 'session-a' })).status).toBe(200);
    expect(client.selectModel).toHaveBeenCalledWith('local', 'model-b');
  });
  it('activates and deactivates models for the composer and persists the list', async () => {
    const catalog = await (await fetch(`${server.url}/api/models/catalog`, { headers: { cookie } })).json();
    expect(catalog).toEqual([
      {
        providerId: 'local',
        models: [
          { modelId: 'model-a', name: 'model-a', active: true },
          { modelId: 'model-b', name: 'model-b', active: true },
        ],
      },
    ]);
    // A disabled provider is never offered, and its models stay out of the list.
    expect(JSON.stringify(catalog)).not.toContain('hidden-model');
    expect(JSON.stringify(catalog)).not.toContain('private-key');

    const off = await post('/api/models/active', { providerId: 'local', modelId: 'model-a', active: false });
    expect(off.status).toBe(200);
    expect(settingsMocks.saveSettings).toHaveBeenCalledWith(
      expect.objectContaining({ providers: expect.objectContaining({ local: expect.objectContaining({ models: ['model-b'] }) }) }),
    );

    settingsMocks.saveSettings.mockClear();
    // The provider switch writes once, not once per model.
    expect((await post('/api/models/active', { providerId: 'local', active: true, all: true })).status).toBe(200);
    expect(settingsMocks.saveSettings).toHaveBeenCalledTimes(1);
    expect(settingsMocks.saveSettings).toHaveBeenCalledWith(
      expect.objectContaining({ providers: expect.objectContaining({ local: expect.objectContaining({ models: [] }) }) }),
    );
  });
  it('stores a new provider key and never sends it back', async () => {
    const list = await (await fetch(`${server.url}/api/providers`, { headers: { cookie } })).json();
    expect(list).toContainEqual(expect.objectContaining({ providerId: 'local', configured: true }));

    settingsMocks.saveSettings.mockClear();
    const response = await post('/api/providers', { providerId: 'local', apiKey: 'second-key-never-exposed' });
    expect(response.status).toBe(200);
    expect(JSON.stringify(await response.json())).not.toContain('second-key-never-exposed');
    expect(settingsMocks.saveSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        providers: expect.objectContaining({
          local: expect.objectContaining({ enabled: true, keys: ['private-key-never-exposed', 'second-key-never-exposed'] }),
        }),
      }),
    );
    // A provider the catalog does not know cannot be invented by the browser.
    settingsMocks.saveSettings.mockClear();
    expect((await post('/api/providers', { providerId: 'not-a-provider-xyz', apiKey: 'k' })).status).toBe(400);
    expect(settingsMocks.saveSettings).not.toHaveBeenCalled();
  });
  it('refuses to activate a model the provider does not offer', async () => {
    // The catalog knows nothing about this provider, so an unknown id must not
    // become a settings entry that later fails at model creation.
    const response = await post('/api/models/active', { providerId: 'local', modelId: 'not-in-catalog', active: true });
    expect(response.status).toBe(400);
    expect(settingsMocks.saveSettings).not.toHaveBeenCalled();
  });
  it('exposes the reviewer settings and revokes a remembered permission', async () => {
    const info = (await (await fetch(`${server.url}/api/approvals`, { headers: { cookie } })).json()) as Record<string, unknown>;
    expect(info).toMatchObject({ mode: 'workspace', supported: ['workspace', 'auto-review', 'full-access'] });
    expect(Array.isArray(info.permissions)).toBe(true);
    expect(info.autoReview).toEqual({ providerId: null, modelId: null, timeoutSeconds: null });
    expect(info.models).toEqual([
      { providerId: 'local', modelId: 'model-a' },
      { providerId: 'local', modelId: 'model-b' },
    ]);

    settingsMocks.saveSettings.mockClear();
    expect((await post('/api/approvals/auto-review', { providerId: 'local', modelId: 'model-b', timeoutSeconds: 30 })).status).toBe(200);
    expect(settingsMocks.saveSettings).toHaveBeenCalledWith(
      expect.objectContaining({ autoReviewProvider: 'local', autoReviewModel: 'model-b', autoReviewTimeoutSeconds: 30 }),
    );
    // The reviewer must be an active model, and the timeout has to be usable.
    expect((await post('/api/approvals/auto-review', { providerId: 'local', modelId: 'not-active' })).status).toBe(400);
    expect((await post('/api/approvals/auto-review', { providerId: 'local', modelId: 'model-a', timeoutSeconds: 2 })).status).toBe(400);
    expect((await post('/api/approvals/forget', { id: 'not-a-hash' })).status).toBe(404);
  });
  it('answers a request for a page it does not have with a 404 instead of a client of its own', async () => {
    const response = await fetch(`${server.url}/`, { headers: { cookie } });
    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).toContain('text/plain');
    expect(await response.text()).toBe('Not found.');
  });
  it('accepts a diagnostic report from the browser without touching the session', async () => {
    const before = snapshot.session.entries.length;
    const response = await post('/api/client-report', { event: 'stream-gap', from: 12, base: 0, length: 3, note: 'x'.repeat(500) });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(snapshot.session.entries.length).toBe(before);
    // A report is not a way to write anything: an unauthenticated caller is refused.
    const anonymous = await fetch(`${server.url}/api/client-report`, {
      method: 'POST',
      headers: { origin: server.url, 'content-type': 'application/json' },
      body: JSON.stringify({ event: 'stream-gap' }),
    });
    expect(anonymous.status).toBe(401);
  });
  it('addresses patches by host entries while the client shows notices of its own', async () => {
    const notice: SessionEntry = { kind: 'notice', text: 'Reconnected to the Ranite host.' };
    const question: SessionEntry = { kind: 'user', text: 'dostum' };
    const answer: SessionEntry = { kind: 'assistant', text: 'cevap' };
    // The daemon client merges its own notices into the snapshot it hands out;
    // the browser never sees them, so every index it receives must come from the
    // host entries alone.
    localNotices.add(notice);
    snapshot = {
      session: { id: 'session-a', title: 'A', entries: [question, notice] },
      busy: true,
      queuedMessageCount: 0,
    } as AgentSessionSnapshot;
    const response = await fetch(`${server.url}/api/events`, { headers: { cookie } });
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const nextEvent = async () => {
      while (true) {
        const end = buffer.indexOf('\n\n');
        if (end >= 0) {
          const frame = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const data = frame.split('\n').find((line) => line.startsWith('data: '));
          if (frame.startsWith('event:') && data) return { event: frame.split('\n')[0], payload: JSON.parse(data.slice(6)) };
          continue;
        }
        const chunk = await reader.read();
        if (chunk.done) throw new Error('Stream ended before the expected event.');
        buffer += decoder.decode(chunk.value, { stream: true });
      }
    };
    try {
      const opened = await nextEvent();
      expect(opened.event).toBe('event: snapshot');
      expect(opened.payload).toMatchObject({ from: 0, totalEntries: 1, entries: [{ text: 'dostum' }] });

      snapshot = { ...snapshot, session: { ...snapshot.session, entries: [question, notice, answer] } };
      publish();

      const patch = await nextEvent();
      expect(patch.event).toBe('event: patch');
      expect(patch.payload).toMatchObject({ reset: false, from: 1, totalEntries: 2, entries: [{ text: 'cevap' }] });
    } finally {
      await reader.cancel();
    }
  });

  it('patches many changed entries instead of resetting the reader back to the window', async () => {
    // A tool batch stamps several entries in one publish. A reset there replaces
    // the reader's list with the newest window and rebuilds every group, which is
    // what made a busy run look like the transcript had fallen apart.
    const entries: SessionEntry[] = Array.from({ length: 200 }, (_, index) => ({ kind: 'user', text: `entry ${index}` }));
    snapshot = { session: { id: 'session-a', title: 'A', entries }, busy: true, queuedMessageCount: 0 } as AgentSessionSnapshot;
    const response = await fetch(`${server.url}/api/events`, { headers: { cookie } });
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const nextEvent = async () => {
      while (true) {
        const end = buffer.indexOf('\n\n');
        if (end >= 0) {
          const frame = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const data = frame.split('\n').find((line) => line.startsWith('data: '));
          if (frame.startsWith('event:') && data) return { event: frame.split('\n')[0], payload: JSON.parse(data.slice(6)) };
          continue;
        }
        const chunk = await reader.read();
        if (chunk.done) throw new Error('Stream ended before the expected event.');
        buffer += decoder.decode(chunk.value, { stream: true });
      }
    };
    try {
      const opened = await nextEvent();
      expect(opened.event).toBe('event: snapshot');

      const stamped = entries.map((entry, index) => (index < 20 ? { ...entry, text: `entry ${index} finished` } : entry));
      snapshot = { ...snapshot, session: { ...snapshot.session, entries: stamped } };
      publish();

      const patch = await nextEvent();
      expect(patch.event).toBe('event: patch');
      expect(patch.payload).toMatchObject({ reset: false });
      expect(patch.payload.updated).toHaveLength(20);
    } finally {
      await reader.cancel();
    }
  });
});
