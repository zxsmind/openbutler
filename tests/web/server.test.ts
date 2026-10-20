import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startWebServer, type WebServer } from '../../src/web/server.js';
import type { AgentSessionClient, AgentSessionSnapshot } from '../../src/agent-session.js';

vi.mock('../../src/daemon-client.js', () => ({ connectDaemonSession: async () => client }));
vi.mock('../../src/settings.js', () => ({
  loadSettings: () => ({
    providers: {
      local: { enabled: true, keys: ['private-key-never-exposed'], models: ['model-a', 'model-b'] },
      disabled: { enabled: false, keys: [], models: ['hidden-model'] },
    },
  }),
}));

let snapshot: AgentSessionSnapshot;
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
  it('lists configured models without credentials and accepts only configured choices', async () => {
    const models = await (await fetch(`${server.url}/api/models`, { headers: { cookie } })).json();
    expect(models).toHaveLength(2);
    expect(JSON.stringify(models)).not.toContain('private-key');
    expect(JSON.stringify(models)).not.toContain('hidden-model');
    expect((await post('/api/model', { providerId: 'local', modelId: 'not-configured', sessionId: 'session-a' })).status).toBe(400);
    expect((await post('/api/model', { providerId: 'local', modelId: 'model-b', sessionId: 'session-a' })).status).toBe(200);
    expect(client.selectModel).toHaveBeenCalledWith('local', 'model-b');
  });
});
