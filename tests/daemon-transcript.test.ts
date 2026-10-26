import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { AgentSessionClient } from '../src/agent-session.js';
import type { DaemonEvent, RuntimeViewData, SessionSnapshotData } from '../src/daemon-protocol.js';
import { LOCAL_NOTICE_TTL_MS } from '../src/local-notices.js';
import type { SessionEntry } from '../src/session-store.js';
import type { WebServer } from '../src/web/server.js';
import { initialSessionState, sessionReducer } from '../web/src/session-state.js';
import { buildTurns } from '../web/src/turns.js';
import type { SessionPayload } from '../web/src/types.js';

let root: string;
let ipc: Server;
let socket: Socket;
let client: AgentSessionClient | undefined;
let web: WebServer | undefined;
let snapshot: SessionSnapshotData;
let runtime: RuntimeViewData;
let connect: typeof import('../src/daemon-client.js').connectDaemonSession;
let supportsClientKind: boolean;

beforeEach(async () => {
  supportsClientKind = true;
  root = mkdtempSync(join(tmpdir(), 'ranite-transcript-'));
  vi.stubEnv('RANITE_DATA_DIR', root);
  vi.resetModules();
  client = undefined;
  web = undefined;
  runtime = {
    workspaceRoot: root,
    modelName: 'Fixture',
    providerId: 'fixture',
    modelId: 'fixture',
    contextWindowTokens: null,
    supportsVision: false,
    reasoningVariants: [],
    reasoningMetadataSource: null,
    reasoningSupport: 'model-unsupported',
    reasoningDefault: 'default',
    showReasoningDefault: true,
  };
  snapshot = {
    session: {
      version: 1,
      id: 'chat',
      title: 'Chat',
      providerId: 'fixture',
      modelId: 'fixture',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      entries: [{ kind: 'user', text: 'First', turnId: 't1' }],
    },
    busy: true,
    pendingApproval: null,
    pendingApprovalId: null,
    pendingQuestion: null,
    queuedMessageCount: 0,
    firstQueuedMessage: null,
    queuedMessages: [],
    sessionSaveError: null,
    streamingAssistantIndex: null,
  };
  ipc = createServer((connection) => {
    socket = connection;
    let buffer = '';
    connection.on('data', (chunk) => {
      buffer += chunk.toString();
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const request = JSON.parse(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        connection.write(
          JSON.stringify({
            version: 2,
            id: request.id,
            ok: true,
            result: {
              snapshot,
              runtime,
              savedSessions: [],
              ...(supportsClientKind ? { clientKind: request.clientKind ?? 'terminal' } : {}),
            },
          }) + '\n',
        );
      }
    });
  });
  const { getDaemonEndpoint } = await import('../src/daemon.js');
  await new Promise<void>((done, fail) => {
    ipc.once('error', fail);
    ipc.listen(getDaemonEndpoint(), done);
  });
  connect = (await import('../src/daemon-client.js')).connectDaemonSession;
});

afterEach(async () => {
  vi.useRealTimers();
  await web?.close();
  client?.close();
  socket?.destroy();
  await new Promise<void>((done) => ipc.close(() => done()));
  vi.unstubAllEnvs();
  if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith('ranite-transcript-'))
    throw new Error('Unsafe transcript fixture cleanup path.');
  rmSync(root, { recursive: true, force: true });
});

function emit(event: DaemonEvent) {
  socket.write(JSON.stringify(event) + '\n');
}

function notify(message: string) {
  emit({ version: 2, event: 'notification', title: 'Connection status', message });
}

function patch(append: SessionEntry[] = [], appendText: Array<{ index: number; delta: string }> = []) {
  const { entries: _entries, ...session } = snapshot.session;
  emit({
    version: 2,
    event: 'patch',
    patch: { ...snapshot, session, runtime, entriesPatch: { kind: 'delta', append, appendText, replace: [] } },
  });
}

it('refuses silent web-to-terminal fallback on an older host while retaining terminal compatibility', async () => {
  supportsClientKind = false;
  await expect(connect(root, { clientKind: 'web' })).rejects.toThrow('Restart the Ranite host');
  client = await connect(root);
  expect(client.getSnapshot().session.id).toBe('chat');
});

it('rejects an unsupported local connection source', async () => {
  // The real host validates this at attach; the fixture returns it to exercise client validation.
  await expect(connect(root, { clientKind: 'telegram' as never })).rejects.toThrow('invalid session attachment');
});

it('expires local notices without changing the host index space used by later text deltas', async () => {
  client = await connect(root);
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  notify('Disconnected');
  notify('Reconnected');
  await vi.waitFor(() => expect(client!.getSnapshot().session.entries).toHaveLength(3));
  const reasoning: SessionEntry = { kind: 'reasoning', text: 'Thinking', turnId: 't1' };
  patch([reasoning]);
  await vi.waitFor(() => expect(client!.getServerEntries()).toHaveLength(2));

  await vi.advanceTimersByTimeAsync(LOCAL_NOTICE_TTL_MS + 50);
  // This used to promote the two expired notices into server entries.
  expect(client.getServerEntries()).toEqual([...snapshot.session.entries, reasoning]);
  expect(client.getSnapshot().session.entries).toEqual(client.getServerEntries());
  patch([], [{ index: 1, delta: ' continues' }]);
  await vi.waitFor(() => expect(client!.getServerEntries()[1]).toMatchObject({ kind: 'reasoning', text: 'Thinking continues' }));
});

it('keeps IPC, web SSE, browser state and turn groups aligned after notice eviction and expiry', async () => {
  const { startWebServer } = await import('../src/web/server.js');
  web = await startWebServer({ workspaceRoot: root, port: 0, assetsDir: join(root, 'no-assets') });
  const paired = await fetch(web.pairUrl, { redirect: 'manual' });
  const cookie = paired.headers.get('set-cookie')!.split(';')[0]!;
  const response = await fetch(`${web.url}/api/events`, { headers: { cookie } });
  const reader = response.body!.getReader();
  let buffer = '';
  const decoder = new TextDecoder();
  let state = initialSessionState;
  const receive = async () => {
    while (true) {
      const boundary = buffer.indexOf('\n\n');
      if (boundary >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        if (!/^event: (snapshot|patch)\n/.test(frame)) continue;
        const data = frame.split('\n').find((line) => line.startsWith('data: '))!;
        const payload = JSON.parse(data.slice(6)) as SessionPayload;
        state = sessionReducer(state, { type: 'payload', payload });
        return payload;
      }
      const chunk = await reader.read();
      if (chunk.done) throw new Error('SSE ended before the transcript update.');
      buffer += decoder.decode(chunk.value, { stream: true });
    }
  };
  try {
    await receive();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    // The cap evicts earlier notices; expiration then removes the rest.
    for (let index = 0; index < 7; index++) {
      notify(`Reconnect ${index}`);
      await receive();
    }
    await vi.advanceTimersByTimeAsync(LOCAL_NOTICE_TTL_MS + 50);
    const expired = await receive();
    expect(expired.totalEntries).toBe(1);
    expect(state.entries).toEqual(snapshot.session.entries);

    const next: SessionEntry[] = [
      { kind: 'assistant', text: 'First answer', turnId: 't1' },
      { kind: 'user', text: 'Second', turnId: 't2' },
      { kind: 'reasoning', text: 'New thought', turnId: 't2' },
    ];
    patch(next);
    await receive();
    patch([], [{ index: 3, delta: ' grows' }]);
    await receive();
    const expected = [...snapshot.session.entries, ...next.slice(0, 2), { ...next[2], text: 'New thought grows' }];
    expect(state.entries).toEqual(expected);
    const turns = buildTurns(state.entries, state.base);
    expect(turns.map((turn) => turn.user?.text)).toEqual(['First', 'Second']);
    expect(turns[0]!.steps).toEqual([]);
    expect(turns[1]!.steps).toEqual([expected[3]]);
  } finally {
    vi.useRealTimers();
    await reader.cancel();
  }
});
