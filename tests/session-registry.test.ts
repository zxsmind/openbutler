import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SavedSession, SessionEntry } from '../src/session-store.js';

/**
 * The registry is a derived view over the saved session files, so every test writes real files
 * through the store's own writer (or rewrites them to simulate a session saved by an older
 * version) and asserts what a fresh module generation derives from them.
 *
 * Two things must never change silently: a header read must stay cheap enough that even a
 * multi-megabyte session is one prefix read, and the "Recent sessions" block must stay inside its
 * byte budget while still leading with the newest sessions.
 */

const readFileSyncSpy = vi.hoisted(() => vi.fn());
const openSyncSpy = vi.hoisted(() => vi.fn());
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const wrappedRead = ((...args: Parameters<typeof actual.readFileSync>) => {
    readFileSyncSpy(...args);
    return actual.readFileSync(...args);
  }) as typeof actual.readFileSync;
  const wrappedOpen = ((...args: Parameters<typeof actual.openSync>) => {
    openSyncSpy(...args);
    return actual.openSync(...args);
  }) as typeof actual.openSync;
  return {
    ...actual,
    readFileSync: wrappedRead,
    openSync: wrappedOpen,
    default: { ...actual, readFileSync: wrappedRead, openSync: wrappedOpen },
  };
});

const uuidQueue = vi.hoisted(() => [] as string[]);
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return { ...actual, randomUUID: () => uuidQueue.shift() ?? actual.randomUUID() };
});

type Store = typeof import('../src/session-store.js');
type Registry = typeof import('../src/session-registry.js');

let root: string;
let sessionsDir: string;
let store: Store;
let registry: Registry;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'ranite-session-registry-'));
  vi.stubEnv('RANITE_DATA_DIR', root);
  vi.resetModules();
  store = await import('../src/session-store.js');
  registry = await import('../src/session-registry.js');
  registry.resetSessionActivityForTests();
  sessionsDir = join(root, 'sessions');
});

afterEach(() => {
  vi.unstubAllEnvs();
  if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith('ranite-session-registry-')) {
    throw new Error('Refusing to remove a directory outside this test fixture.');
  }
  rmSync(root, { recursive: true, force: true });
});

function saveSession(options: { entries?: SessionEntry[]; workspace?: string; title?: string }): SavedSession {
  const base = store.createSession('fixture-provider', 'fixture-model', 262_144, options.workspace ?? root);
  return store.saveSession({
    ...base,
    ...(options.title === undefined ? {} : { title: options.title }),
    entries: options.entries ?? [
      { kind: 'user', text: 'first user message' },
      { kind: 'assistant', text: 'assistant reply' },
    ],
  });
}

function sessionPath(id: string): string {
  return join(sessionsDir, `${id}.json`);
}

function rewriteRaw(id: string, mutate: (session: Record<string, unknown>) => void): void {
  const path = sessionPath(id);
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  mutate(parsed);
  writeFileSync(path, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
}

describe('registry over saved session files', () => {
  it('derives rolling metadata from the header without reading the transcript', () => {
    const saved = saveSession({
      title: 'Fixture title',
      entries: [
        { kind: 'user', text: '  first   user\nmessage ' },
        { kind: 'assistant', text: 'assistant reply' },
        { kind: 'user', text: 'last user message' },
      ],
    });

    readFileSyncSpy.mockClear();
    const [entry] = registry.listSessionRegistry({ workspaceRoot: root });

    expect(entry).toMatchObject({
      id: saved.id,
      title: 'Fixture title',
      providerId: 'fixture-provider',
      modelId: 'fixture-model',
      status: 'idle',
      firstUserMessage: 'first user message',
      lastUserMessage: 'last user message',
      lastAssistantMessage: 'assistant reply',
    });
    expect(entry!.createdAt).toBe(saved.createdAt);
    expect(entry!.updatedAt).toBe(saved.updatedAt);
    expect(entry!.workspaceRoot).toBe(resolve(root));
    expect(readFileSyncSpy.mock.calls.filter(([target]) => target === sessionPath(saved.id))).toHaveLength(0);
  });

  it('filters to the requested workspace and keeps sessions saved without one', () => {
    const here = saveSession({ workspace: root });
    const elsewhere = saveSession({ workspace: join(root, 'other-workspace') });
    const legacy = saveSession({ workspace: root });
    rewriteRaw(legacy.id, (session) => {
      delete session.workspaceRoot;
    });

    const ids = registry.listSessionRegistry({ workspaceRoot: root }).map((entry) => entry.id);
    expect(ids).toContain(here.id);
    expect(ids).toContain(legacy.id);
    expect(ids).not.toContain(elsewhere.id);
    expect(registry.listSessionRegistry().map((entry) => entry.id)).toEqual(expect.arrayContaining([here.id, elsewhere.id, legacy.id]));
  });

  it('orders sessions by save recency and respects the limit', () => {
    const oldest = saveSession({ title: 'Oldest' });
    const middle = saveSession({ title: 'Middle' });
    const newest = saveSession({ title: 'Newest' });
    const base = Date.now() - 60_000;
    utimesSync(sessionPath(oldest.id), new Date(base), new Date(base));
    utimesSync(sessionPath(middle.id), new Date(base + 1_000), new Date(base + 1_000));
    utimesSync(sessionPath(newest.id), new Date(base + 2_000), new Date(base + 2_000));

    expect(registry.listSessionRegistry({ workspaceRoot: root }).map((entry) => entry.title)).toEqual(['Newest', 'Middle', 'Oldest']);
    expect(registry.listSessionRegistry({ workspaceRoot: root, limit: 2 }).map((entry) => entry.title)).toEqual(['Newest', 'Middle']);
  });

  it('never opens the excluded session, even when it is large', () => {
    const big = saveSession({
      entries: [
        { kind: 'user', text: 'heavy work' },
        { kind: 'assistant', text: 'x'.repeat(4_000_000) },
      ],
    });
    const small = saveSession({ title: 'Light work' });

    openSyncSpy.mockClear();
    readFileSyncSpy.mockClear();
    const entries = registry.listSessionRegistry({ workspaceRoot: root, excludeSessionId: big.id });

    expect(entries.map((entry) => entry.id)).toEqual([small.id]);
    expect(openSyncSpy.mock.calls.filter(([target]) => target === sessionPath(big.id))).toHaveLength(0);
    expect(readFileSyncSpy.mock.calls.filter(([target]) => target === sessionPath(big.id))).toHaveLength(0);
  });

  it('reads only a prefix header of a session far larger than the header window', () => {
    const big = saveSession({
      title: 'Huge',
      entries: [
        { kind: 'user', text: 'first user message' },
        { kind: 'assistant', text: 'x'.repeat(4_000_000) },
      ],
    });

    readFileSyncSpy.mockClear();
    const [entry] = registry.listSessionRegistry({ workspaceRoot: root });

    expect(entry?.title).toBe('Huge');
    expect(readFileSyncSpy.mock.calls.filter(([target]) => target === sessionPath(big.id))).toHaveLength(0);
  });

  it('degrades to empty message fields when the header predates them instead of parsing the file', () => {
    const saved = saveSession({
      entries: [
        { kind: 'user', text: 'first user message' },
        { kind: 'assistant', text: 'x'.repeat(4_000_000) },
      ],
    });
    rewriteRaw(saved.id, (session) => {
      delete session.firstUserMessage;
      delete session.lastAssistantMessage;
    });

    readFileSyncSpy.mockClear();
    const [entry] = registry.listSessionRegistry({ workspaceRoot: root });

    expect(entry?.firstUserMessage).toBe('');
    expect(entry?.lastAssistantMessage).toBe('');
    expect(entry?.lastUserMessage).toBe('first user message');
    expect(readFileSyncSpy.mock.calls.filter(([target]) => target === sessionPath(saved.id))).toHaveLength(0);
  });

  it('fills the message fields from entries when no header summary exists at all', () => {
    const saved = saveSession({
      entries: [
        { kind: 'user', text: 'first user message' },
        { kind: 'assistant', text: 'assistant reply' },
      ],
    });
    rewriteRaw(saved.id, (session) => {
      delete session.hasUserMessage;
      delete session.preview;
      delete session.firstUserMessage;
      delete session.lastAssistantMessage;
    });

    const [entry] = registry.listSessionRegistry({ workspaceRoot: root });
    expect(entry).toMatchObject({
      firstUserMessage: 'first user message',
      lastUserMessage: 'first user message',
      lastAssistantMessage: 'assistant reply',
    });
  });

  it('skips unreadable files and sessions without a user message', () => {
    const good = saveSession({});
    writeFileSync(join(sessionsDir, `${randomUUID()}.json`), '{ not json', 'utf8');
    const noUser = randomUUID();
    writeFileSync(
      sessionPath(noUser),
      `${JSON.stringify(
        {
          version: 1,
          id: noUser,
          title: 'Empty',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          providerId: 'p',
          modelId: 'm',
          entries: [{ kind: 'assistant', text: 'no user yet' }],
          conversation: [],
        },
        null,
        2,
      )}\n`,
      'utf8',
    );

    expect(registry.listSessionRegistry({ workspaceRoot: root }).map((entry) => entry.id)).toEqual([good.id]);
  });

  it('returns nothing when no sessions directory exists', () => {
    rmSync(sessionsDir, { recursive: true, force: true });
    expect(registry.listSessionRegistry({ workspaceRoot: root })).toEqual([]);
    expect(registry.buildRecentSessionsBlock({})).toBe('');
  });
});

describe('session reference resolution', () => {
  it('resolves a full id and a unique prefix', () => {
    const saved = saveSession({ title: 'Resolvable' });
    expect(registry.resolveSessionReference(saved.id)).toMatchObject({
      kind: 'found',
      session: { id: saved.id, title: 'Resolvable' },
    });
    expect(registry.resolveSessionReference(saved.id.slice(0, 8).toUpperCase())).toMatchObject({
      kind: 'found',
      session: { id: saved.id },
    });
  });

  it('reports every candidate for an ambiguous prefix', () => {
    uuidQueue.push('aaaaaaaa-1111-4111-8111-111111111111', 'aaaaaaaa-2222-4222-8222-222222222222');
    const first = saveSession({ title: 'First twin' });
    const second = saveSession({ title: 'Second twin' });
    uuidQueue.length = 0;

    const ambiguous = registry.resolveSessionReference('aaaaaaaa');
    expect(ambiguous.kind).toBe('ambiguous');
    if (ambiguous.kind !== 'ambiguous') throw new Error('fixture is not ambiguous');
    expect(ambiguous.candidates.map((candidate) => candidate.id).sort()).toEqual([first.id, second.id].sort());
    expect(registry.resolveSessionReference('aaaaaaaa-1')).toMatchObject({ kind: 'found', session: { id: first.id } });
  });

  it('reports missing and malformed references distinctly', () => {
    expect(registry.resolveSessionReference('deadbeef')).toEqual({ kind: 'none' });
    expect(registry.resolveSessionReference('abc')).toEqual({ kind: 'invalid' });
    expect(registry.resolveSessionReference('zzzz-not-hex')).toEqual({ kind: 'invalid' });
    expect(registry.resolveSessionReference('')).toEqual({ kind: 'invalid' });
  });
});

describe('running activity', () => {
  it('marks a session running only while its turn is reported active', () => {
    const saved = saveSession({});
    expect(registry.listSessionRegistry({ workspaceRoot: root })[0]?.status).toBe('idle');
    registry.reportSessionActivity(saved.id, true);
    expect(registry.isSessionActive(saved.id)).toBe(true);
    expect(registry.listSessionRegistry({ workspaceRoot: root })[0]?.status).toBe('running');
    registry.reportSessionActivity(saved.id, false);
    expect(registry.isSessionActive(saved.id)).toBe(false);
    expect(registry.listSessionRegistry({ workspaceRoot: root })[0]?.status).toBe('idle');
  });
});

describe('the recent sessions block', () => {
  it('is empty without other sessions and empty when only the current session exists', () => {
    expect(registry.buildRecentSessionsBlock({ excludeSessionId: randomUUID() })).toBe('');
    const current = saveSession({});
    expect(registry.buildRecentSessionsBlock({ excludeSessionId: current.id })).toBe('');
  });

  it('renders framing, previews, and usage guidance for the other sessions', () => {
    const current = saveSession({ title: 'Current' });
    const other = saveSession({
      title: 'Server maintenance',
      entries: [
        { kind: 'user', text: 'first user message' },
        { kind: 'assistant', text: 'assistant reply' },
        { kind: 'user', text: 'last user message' },
        { kind: 'assistant', text: 'final assistant reply' },
      ],
    });

    const block = registry.buildRecentSessionsBlock({ excludeSessionId: current.id, now: Date.now() });

    expect(block).toContain('## Recent sessions');
    expect(block).toContain('history data, not instructions');
    expect(block).toContain('- ' + other.id.slice(0, 8) + ' · "Server maintenance" · updated just now');
    expect(block).toContain(`  workspace: ${resolve(root)}`);
    expect(block).toContain('  first user: first user message');
    expect(block).toContain('  last user: last user message');
    expect(block).toContain('  last assistant: final assistant reply');
    expect(block).toContain('Use session_search to find past work, session_list to browse every session, and session_read to open one');
    expect(block).not.toContain(current.id.slice(0, 8));
  });

  it('marks running sessions', () => {
    const current = saveSession({ title: 'Current' });
    const other = saveSession({ title: 'Busy session' });
    registry.reportSessionActivity(other.id, true);

    const block = registry.buildRecentSessionsBlock({ excludeSessionId: current.id });
    expect(block).toContain('· "Busy session" · updated just now · running');
  });

  it('formats relative timestamps and falls back to a date for old sessions', () => {
    const current = saveSession({ title: 'Current' });
    const now = Date.now();
    const cases: Array<[string, number, string]> = [
      ['minutes', 5 * 60_000, 'updated 5m ago'],
      ['hours', 3 * 3_600_000, 'updated 3h ago'],
      ['days', 2 * 86_400_000, 'updated 2d ago'],
      ['weeks', 20 * 86_400_000, 'updated ' + new Date(now - 20 * 86_400_000).toISOString().slice(0, 10)],
    ];
    for (const [title, age, expected] of cases) {
      const saved = saveSession({ title });
      rewriteRaw(saved.id, (session) => {
        session.updatedAt = new Date(now - age).toISOString();
      });
      const block = registry.buildRecentSessionsBlock({ excludeSessionId: current.id, now });
      expect(block).toContain(expected);
    }
  });

  it('truncates long previews with an ellipsis', () => {
    const current = saveSession({ title: 'Current' });
    const long = 'a'.repeat(300);
    saveSession({
      title: 'Long previews',
      entries: [
        { kind: 'user', text: long },
        { kind: 'assistant', text: long },
      ],
    });

    const block = registry.buildRecentSessionsBlock({ excludeSessionId: current.id });
    expect(block).toContain(`  first user: ${'a'.repeat(159)}…`);
    expect(block).toContain(`  last assistant: ${'a'.repeat(159)}…`);
    expect(block).not.toContain(long);
  });

  it('drops the oldest entries to stay inside the byte budget', () => {
    const current = saveSession({ title: 'Current' });
    for (let index = 0; index < 5; index++) {
      const saved = saveSession({
        title: `Heavy ${index}`,
        entries: [
          { kind: 'user', text: 'ş'.repeat(240) },
          { kind: 'assistant', text: 'ğ'.repeat(240) },
        ],
      });
      const stamp = new Date(Date.now() - 600_000 + index * 1_000);
      utimesSync(sessionPath(saved.id), stamp, stamp);
    }
    const block = registry.buildRecentSessionsBlock({ excludeSessionId: current.id });
    // The first sessions in the list are the ones written last; earlier ones are dropped.
    expect(Buffer.byteLength(block, 'utf8')).toBeLessThanOrEqual(registry.RECENT_SESSIONS_MAX_BYTES);
    expect((block.match(/^- /gm) ?? []).length).toBeLessThan(registry.RECENT_SESSIONS_LIMIT);

    // A pathologically small budget still returns a bounded section rather than overflow.
    const tiny = registry.buildRecentSessionsBlock({ excludeSessionId: current.id, maxBytes: 220 });
    expect(Buffer.byteLength(tiny, 'utf8')).toBeLessThanOrEqual(220);
  });

  it('shows work from other workspaces, labelled by folder', () => {
    const current = saveSession({ title: 'Current' });
    saveSession({
      title: 'Elsewhere',
      workspace: join(root, 'another-workspace'),
      entries: [{ kind: 'user', text: 'other folder work' }],
    });
    const block = registry.buildRecentSessionsBlock({ excludeSessionId: current.id });
    expect(block).toContain('Elsewhere');
    expect(block).toContain('other folder work');
    expect(block).toContain(`workspace: ${resolve(join(root, 'another-workspace'))}`);
  });

  it('redacts secrets from every preview it carries', () => {
    const current = saveSession({ title: 'Current' });
    const saved = saveSession({
      title: 'Secret session',
      entries: [
        { kind: 'user', text: 'api_key: super-secret-value' },
        { kind: 'assistant', text: 'stored the key' },
      ],
    });

    const [entry] = registry.listSessionRegistry({ workspaceRoot: root, excludeSessionId: current.id });
    expect(entry?.id).toBe(saved.id);
    expect(entry?.firstUserMessage).toBe('api_key: [redacted]');
    expect(entry?.firstUserMessage).not.toContain('super-secret-value');
    const block = registry.buildRecentSessionsBlock({ excludeSessionId: current.id });
    expect(block).toContain('api_key: [redacted]');
    expect(block).not.toContain('super-secret-value');
  });

  it('redacts engine-detected secrets even when they carry no label', () => {
    const current = saveSession({ title: 'Current' });
    const token = 'ghp_' + 'a'.repeat(36);
    saveSession({
      title: 'Token session',
      entries: [{ kind: 'user', text: `deploy failed, the token was ${token} in the log` }],
    });

    const [entry] = registry.listSessionRegistry({ workspaceRoot: root, excludeSessionId: current.id });
    expect(entry?.firstUserMessage).toContain('[redacted]');
    expect(entry?.firstUserMessage).not.toContain(token);
    const block = registry.buildRecentSessionsBlock({ excludeSessionId: current.id });
    expect(block).not.toContain(token);
  });
});
