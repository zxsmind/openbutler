import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { browserWebAddress, startWebServer, tailWindowStart, type WebServer } from '../../src/web/server.js';
import {
  BRAND_LOGO_URL,
  BRAND_FAVICON_SVG_URL,
  BRAND_FAVICON_ICO_URL,
  BRAND_FAVICON_PNG_URL,
  BRAND_APPLE_TOUCH_ICON_URL,
  readBrandLogo,
} from '../../src/branding.js';
import type { AgentSessionClient, AgentSessionSnapshot } from '../../src/agent-session.js';
import type { SessionEntry } from '../../src/session-store.js';
import { connectDaemonSession } from '../../src/daemon-client.js';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

vi.mock('../../src/daemon-client.js', () => ({ connectDaemonSession: vi.fn() }));
const settingsMocks = vi.hoisted(() => ({ saveSettings: vi.fn() }));
vi.mock('../../src/settings.js', () => ({
  getSettingsPath: () => join(process.env.RANITE_DATA_DIR!, 'settings.yaml'),
  getConfigPath: () => join(process.env.RANITE_DATA_DIR!, 'config.yaml'),
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
    saveReasoningPreference: vi.fn((variantId: string) => {
      Object.assign(client.runtime, { reasoningDefault: variantId });
    }),
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
  stop: vi.fn(() => {
    snapshot.busy = false;
    publish();
  }),
  selectModel: vi.fn(async (providerId: string, modelId: string) => {
    Object.assign(client.runtime, { providerId, modelId });
    publish();
  }),
  close: vi.fn(),
} as unknown as AgentSessionClient;
let server: WebServer;
let cookie: string;
let dataDirectory: string;
const actors = new Map<string, AgentSessionClient>();
function actor(id: string): AgentSessionClient {
  const state = {
    ...snapshot,
    busy: false,
    queuedMessageCount: 0,
    session: { ...snapshot.session, id, title: id, entries: id === 'new-session' ? [] : [{ kind: 'user' as const, text: id }] },
  };
  const subscribers = new Set<() => void>();
  const changed = () => {
    for (const subscriber of subscribers) subscriber();
  };
  const value = {
    ...client,
    runtime: { ...client.runtime },
    get isBusy() {
      return state.busy;
    },
    getSnapshot: () => state,
    getServerEntries: () => state.session.entries,
    subscribe: (listener: () => void) => {
      subscribers.add(listener);
      return () => subscribers.delete(listener);
    },
    sendMessage: vi.fn(async () => {}),
    stop: vi.fn(() => {
      state.busy = false;
      changed();
    }),
    close: vi.fn(),
  } as AgentSessionClient;
  actors.set(id, value);
  return value;
}
const post = (path: string, body: unknown) =>
  fetch(`${server.url}${path}`, {
    method: 'POST',
    headers: {
      cookie,
      origin: server.url,
      'content-type': 'application/json',
      ...((body as { currentSessionId?: string; sessionId?: string }).currentSessionId || (body as { sessionId?: string }).sessionId
        ? { 'x-ranite-session': (body as { currentSessionId?: string }).currentSessionId ?? (body as { sessionId: string }).sessionId }
        : {}),
    },
    body: JSON.stringify(body),
  });

beforeEach(async () => {
  dataDirectory = await mkdtemp(join(tmpdir(), 'ranite-web-session-'));
  vi.stubEnv('RANITE_DATA_DIR', dataDirectory);
  vi.clearAllMocks();
  listeners.clear();
  actors.clear();
  snapshot = {
    session: { id: 'session-a', title: 'A', entries: [{ kind: 'user', text: 'A' }] },
    busy: false,
    queuedMessageCount: 0,
  } as AgentSessionSnapshot;
  Object.assign(client.runtime, { providerId: 'local', modelId: 'model-a' });
  vi.mocked(connectDaemonSession).mockImplementation(async (_path, options) =>
    options?.newChatSession
      ? actor('new-session')
      : options?.chatSessionId
        ? (actors.get(options.chatSessionId) ?? actor(options.chatSessionId))
        : client,
  );
  server = await startWebServer({ workspaceRoot: 'C:/workspace', port: 0, assetsDir: 'missing-test-assets' });
  const paired = await fetch(server.pairUrl, { redirect: 'manual' });
  cookie = paired.headers.get('set-cookie')!.split(';')[0];
});
afterEach(async () => {
  await server?.close();
  vi.unstubAllEnvs();
  if (dirname(resolve(dataDirectory)) !== resolve(tmpdir()) || !basename(dataDirectory).startsWith('ranite-web-session-'))
    throw new Error('Unsafe fixture cleanup path.');
  await rm(dataDirectory, { recursive: true, force: true });
});

describe('browser session controls', () => {
  it('opens a reader window at the next message boundary, not mid-turn', () => {
    const work = (count: number, offset = 0): { kind: string; result: string }[] =>
      Array.from({ length: count }, (_, index) => ({ kind: 'tool', result: `t${offset + index}` }));
    // A blind tail of 100 would cut at index 11, inside the work before the ask.
    const entries = [...work(50), { kind: 'user', text: 'boundary' }, ...work(60)];
    expect(tailWindowStart(entries)).toBe(50);
    // A work-only tail has no boundary to open on; the blind tail stands.
    expect(tailWindowStart(work(120))).toBe(20);
    const short: { kind: string }[] = [{ kind: 'assistant' }];
    expect(tailWindowStart(short, 100)).toBe(0);
  });

  it('serves real favicon formats without requiring browser pairing', async () => {
    const icons = [
      { path: BRAND_FAVICON_ICO_URL, type: 'image/x-icon' },
      { path: BRAND_FAVICON_PNG_URL, type: 'image/png' },
      { path: BRAND_FAVICON_SVG_URL, type: 'image/svg+xml' },
      { path: BRAND_APPLE_TOUCH_ICON_URL, type: 'image/png' },
    ];
    for (const icon of icons) {
      const url = new URL(icon.path + '?v=cache-key', server.url);
      const response = await fetch(url);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain(icon.type);
      expect(response.headers.get('cache-control')).toContain('must-revalidate');
      const bytes = Buffer.from(await response.arrayBuffer());
      expect(bytes.length).toBeGreaterThan(50);
      if (icon.type === 'image/x-icon') {
        expect(bytes.readUInt16LE(2)).toBe(1);
        expect(bytes.readUInt16LE(4)).toBe(3);
      }
      if (icon.type === 'image/png') expect(bytes.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
      if (icon.path === BRAND_FAVICON_SVG_URL) expect(bytes.toString('utf8')).toContain('prefers-color-scheme: dark');
      const etag = response.headers.get('etag');
      expect(etag).toBeTruthy();
      expect((await fetch(url, { headers: { 'if-none-match': etag! } })).status).toBe(304);
    }
    expect((await fetch(new URL('/brand/unknown.svg', server.url))).status).toBe(404);
  });

  it('serves the canonical brand SVG publicly and supports HTTP cache revalidation', async () => {
    const response = await fetch(new URL(BRAND_LOGO_URL, server.url));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(/^image\/svg\+xml/);
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await response.text()).toBe((await readBrandLogo()).toString('utf8'));
    const etag = response.headers.get('etag');
    expect(etag).toMatch(/^"[a-f0-9]{16}"$/);
    const cached = await fetch(new URL(BRAND_LOGO_URL, server.url), { headers: { 'if-none-match': etag! } });
    expect(cached.status).toBe(304);
    expect(await cached.text()).toBe('');
    const head = await fetch(new URL(BRAND_LOGO_URL, server.url), { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
  });

  it('keeps the listening address separate from the browser address', () => {
    expect(browserWebAddress('0.0.0.0', 45278)).toBe('http://127.0.0.1:45278');
    expect(browserWebAddress('::', 45278)).toBe('http://127.0.0.1:45278');
    expect(browserWebAddress('127.0.0.1', 45278)).toBe('http://127.0.0.1:45278');
    expect(browserWebAddress('192.168.1.20', 45278)).toBe('http://192.168.1.20:45278');
    expect(browserWebAddress('::1', 45278)).toBe('http://[::1]:45278');
  });

  it('applies an effort change while a run is going, unlike a model change', async () => {
    snapshot.busy = true;
    publish();
    // No session header: the busy gate must hold on the default client itself.
    const postDefault = (path: string, body: unknown) =>
      fetch(`${server.url}${path}`, {
        method: 'POST',
        headers: { cookie, origin: server.url, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    const modelChange = await postDefault('/api/model', { providerId: 'local', modelId: 'model-a', sessionId: 'session-a' });
    expect(modelChange.status).toBe(409);
    // The effort is a preference: no busy gate, and the payload carries the new default.
    const effort = await postDefault('/api/reasoning', { reasoningVariantId: 'high', sessionId: 'session-a' });
    expect(effort.status).toBe(200);
    expect(client.runtime.saveReasoningPreference).toHaveBeenCalledWith('high');
    expect(((await effort.json()) as { runtime: { reasoningDefault: string } }).runtime.reasoningDefault).toBe('high');
    const unsupported = await postDefault('/api/reasoning', { reasoningVariantId: 'nope', sessionId: 'session-a' });
    expect(unsupported.status).toBe(400);
    const stale = await postDefault('/api/reasoning', { reasoningVariantId: 'high', sessionId: 'session-b' });
    expect(stale.status).toBe(409);
    snapshot.busy = false;
    publish();
  });

  it('serves usable pairing links when listening on all IPv4 interfaces', async () => {
    const wildcard = await startWebServer({
      workspaceRoot: 'C:/workspace',
      port: 0,
      host: '0.0.0.0',
      assetsDir: 'missing-test-assets',
    });
    try {
      expect(new URL(wildcard.url).hostname).toBe('127.0.0.1');
      expect(new URL(wildcard.pairUrl).origin).toBe(wildcard.url);
      const response = await fetch(wildcard.pairUrl, { redirect: 'manual' });
      expect(response.status).toBe(302);
      expect(response.headers.get('set-cookie')).toContain('HttpOnly');
      expect((await fetch(wildcard.pairUrl, { redirect: 'manual' })).status).toBe(403);

      const refreshed = wildcard.newPairUrl();
      expect(new URL(refreshed).origin).toBe(wildcard.url);
      expect((await fetch(refreshed, { redirect: 'manual' })).status).toBe(302);
    } finally {
      await wildcard.close();
    }
  });

  it('notifies every open browser when model settings or the catalog change on disk', async () => {
    const streams = await Promise.all([
      fetch(`${server.url}/api/events`, { headers: { cookie }, signal: AbortSignal.timeout(5000) }),
      fetch(`${server.url}/api/events`, { headers: { cookie }, signal: AbortSignal.timeout(5000) }),
    ]);
    const readers = streams.map((response) => response.body!.getReader());
    const buffers = ['', ''];
    const nextModelChange = async (index: number) => {
      while (!buffers[index]!.includes('event: models-changed\ndata: {}\n\n')) {
        const chunk = await readers[index]!.read();
        if (chunk.done) throw new Error('Stream ended before the model change.');
        buffers[index] += new TextDecoder().decode(chunk.value);
      }
      buffers[index] = '';
    };
    try {
      await writeFile(join(dataDirectory, 'settings.yaml'), 'providers: {}');
      await Promise.all(readers.map((_, index) => nextModelChange(index)));
      await writeFile(join(dataDirectory, 'catalog-index.json'), '{}');
      await Promise.all(readers.map((_, index) => nextModelChange(index)));
    } finally {
      await Promise.all(readers.map((reader) => reader.cancel()));
    }
  });

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
  it('keeps an existing stream bound to its chat when another view opens a different chat', async () => {
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
          if (frame.startsWith('event:') && !frame.startsWith('event: sessions-changed')) return frame;
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
      expect(snapshot.session.id).toBe('session-a');
      snapshot = {
        ...snapshot,
        session: { ...snapshot.session, entries: [...snapshot.session.entries, { kind: 'assistant', text: 'A continued.' }] },
      };
      publish();
      const continued = await event();
      expect(continued).toContain('event: patch');
      expect(continued).toContain('"id":"session-a"');
      expect(continued).not.toContain('"id":"session-b"');
      const other = (await (await fetch(`${server.url}/api/snapshot?sessionId=session-b`, { headers: { cookie } })).json()) as {
        session: { id: string };
      };
      expect(other.session.id).toBe('session-b');
    } finally {
      await reader.cancel();
    }
  });
  it('opens other chats while the current chat is busy or queued, and rejects unknown IDs', async () => {
    snapshot.busy = true;
    expect((await post('/api/session', { action: 'new', currentSessionId: 'session-a' })).status).toBe(200);
    expect(snapshot.busy).toBe(true);
    snapshot.busy = false;
    snapshot.queuedMessageCount = 1;
    expect((await post('/api/session', { action: 'load', sessionId: 'session-b', currentSessionId: 'session-a' })).status).toBe(200);
    snapshot.queuedMessageCount = 0;
    expect((await post('/api/session', { action: 'new', currentSessionId: 'stale-chat' })).status).toBe(404);
    expect(newSession).not.toHaveBeenCalled();
  });
  it('creates an empty chat without sending anything to a model', async () => {
    const response = await post('/api/session', { action: 'new', currentSessionId: 'session-a' });
    expect(await response.json()).toMatchObject({ reset: true, session: { id: 'new-session', hasUserMessage: false }, entries: [] });
    expect(send).not.toHaveBeenCalled();
  });
  it('keeps conversation presence when the user message is outside the visible transcript window', async () => {
    snapshot.session.entries = [
      { kind: 'user', text: 'First message' },
      ...Array.from({ length: 120 }, () => ({ kind: 'assistant' as const, text: 'Fixture' })),
    ];
    const response = await fetch(`${server.url}/api/snapshot`, { headers: { cookie } });
    const payload = (await response.json()) as { session: { hasUserMessage: boolean }; entries: SessionEntry[] };
    expect(payload.session.hasUserMessage).toBe(true);
    expect(payload.entries.some((entry) => entry.kind === 'user')).toBe(false);
  });
  it('routes messages and stop controls to the addressed chat, with no cross-chat fallback', async () => {
    snapshot.busy = true;
    await post('/api/session', { action: 'load', sessionId: 'session-b', currentSessionId: 'session-a' });
    const other = actors.get('session-b')!;
    other.getSnapshot().busy = true;
    expect((await post('/api/message', { text: 'Only B.', sessionId: 'session-b' })).status).toBe(200);
    expect(other.sendMessage).toHaveBeenCalledWith({ text: 'Only B.', images: [] }, expect.anything());
    expect(send).not.toHaveBeenCalled();
    expect((await post('/api/stop', {})).status).toBe(409);
    expect((await post('/api/stop', { sessionId: 'session-b' })).status).toBe(200);
    expect(other.stop).toHaveBeenCalledOnce();
    expect(client.stop).not.toHaveBeenCalled();
    expect(snapshot.busy).toBe(true);
    const conflict = await fetch(`${server.url}/api/message`, {
      method: 'POST',
      headers: { cookie, origin: server.url, 'content-type': 'application/json', 'x-ranite-session': 'session-a' },
      body: JSON.stringify({ text: 'Mismatch', sessionId: 'session-b' }),
    });
    expect(conflict.status).toBe(409);
    expect(send).not.toHaveBeenCalled();
  });
  it('does not send or load history into the wrong chat', async () => {
    expect((await post('/api/message', { text: 'Keep my draft', sessionId: 'old-chat' })).status).toBe(404);
    expect(send).not.toHaveBeenCalled();
    expect((await fetch(`${server.url}/api/entries?before=1&sessionId=old-chat`, { headers: { cookie } })).status).toBe(404);
    expect((await post('/api/message', { text: 'Hello', sessionId: 'session-a' })).status).toBe(200);
    expect(send).toHaveBeenCalledWith({ text: 'Hello', images: [] }, expect.anything());
  });
  it('declares web identity on the connection and ignores identity in the HTTP message body', async () => {
    expect(connectDaemonSession).toHaveBeenCalledWith('C:/workspace', { clientKind: 'web' });
    const response = await post('/api/message', {
      text: 'Browser message',
      sessionId: 'session-a',
      clientKind: 'terminal',
      communication: { source: 'telegram' },
    });
    expect(response.status).toBe(200);
    expect(send).toHaveBeenCalledWith({ text: 'Browser message', images: [] }, expect.anything());
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
          if (frame.startsWith('event:') && !frame.startsWith('event: sessions-changed') && data)
            return { event: frame.split('\n')[0], payload: JSON.parse(data.slice(6)) };
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
          if (frame.startsWith('event:') && !frame.startsWith('event: sessions-changed') && data)
            return { event: frame.split('\n')[0], payload: JSON.parse(data.slice(6)) };
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
