import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SavedSession } from '../src/session-store.js';

// Records every `readFileSync` the module under test performs, so the tests can prove that listing
// never touches the transcript. Correctness alone cannot catch a regression here: a full parse would
// still return the right summary, just slowly.
const readFileSyncSpy = vi.hoisted(() => vi.fn());
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const wrapped = ((...args: Parameters<typeof actual.readFileSync>) => {
    readFileSyncSpy(...args);
    return actual.readFileSync(...args);
  }) as typeof actual.readFileSync;
  return { ...actual, readFileSync: wrapped, default: { ...actual, readFileSync: wrapped } };
});

/**
 * Listing used to read and parse every byte of every session file, on every TUI attach and every
 * time the session picker opened. The display fields are now denormalised onto the saved session so
 * listing can read a header from the front of the file and never touch `entries`.
 *
 * These tests pin both halves: the summary must equal what a full parse produces, and the fast
 * header read must be chosen. A wrong header would silently show a stale or empty picker.
 *
 * `session-store` resolves its directory when the module loads, so the env stub has to be in place
 * and the module cache dropped before each case.
 */

type Store = typeof import('../src/session-store.js');

let root: string;
let sessionsDir: string;
let store: Store;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'ranite-session-list-'));
  vi.stubEnv('RANITE_DATA_DIR', root);
  vi.resetModules();
  store = await import('../src/session-store.js');
  sessionsDir = join(root, 'sessions');
});

afterEach(() => {
  vi.unstubAllEnvs();
  if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith('ranite-session-list-')) {
    throw new Error('Refusing to remove a directory outside this test fixture.');
  }
  rmSync(root, { recursive: true, force: true });
});

function bigSession(title: string, filler: number): SavedSession {
  const base = store.createSession('p', 'm', 262_144, root);
  return {
    ...base,
    title,
    // A tool result is capped at 80 KB, so this is a realistic pair of heavy messages.
    entries: [
      { kind: 'user', text: `first ${title}` },
      { kind: 'assistant', text: 'x'.repeat(filler) },
      { kind: 'user', text: `last ${title}` },
    ],
    conversation: [{ role: 'user', content: 'c'.repeat(filler) }],
  };
}

function readRaw(id: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(sessionsDir, `${id}.json`), 'utf8')) as Record<string, unknown>;
}

describe('session listing reads a header instead of the whole file', () => {
  it('denormalises the display fields before entries so the header read can find them', () => {
    const saved = store.saveSession(bigSession('Header order', 4_000));
    const order = Object.keys(readRaw(saved.id));
    expect(order.indexOf('hasUserMessage')).toBeGreaterThan(-1);
    expect(order.indexOf('hasUserMessage')).toBeLessThan(order.indexOf('entries'));
    expect(order.indexOf('preview')).toBeLessThan(order.indexOf('entries'));
  });

  it('produces the same summary a full parse would', () => {
    const saved = store.saveSession(bigSession('Summary parity', 4_000));
    const raw = readRaw(saved.id) as unknown as SavedSession;
    const listed = store.listSavedSessions().find((entry) => entry.id === saved.id);

    expect(listed).toBeDefined();
    expect(listed?.title).toBe(raw.title);
    expect(listed?.preview).toBe('last Summary parity');
    expect(listed?.updatedAt).toBe(raw.updatedAt);
    expect(listed?.providerId).toBe(raw.providerId);
    expect(listed?.modelId).toBe(raw.modelId);
  });

  it('writes the cross-session context fields before entries', () => {
    const saved = store.saveSession(bigSession('Block fields', 4_000));
    const raw = readRaw(saved.id);

    expect(raw.firstUserMessage).toBe('first Block fields');
    expect(raw.lastAssistantMessage).toBe('x'.repeat(240));
    const order = Object.keys(raw);
    expect(order.indexOf('firstUserMessage')).toBeGreaterThan(-1);
    expect(order.indexOf('firstUserMessage')).toBeLessThan(order.indexOf('entries'));
    expect(order.indexOf('lastAssistantMessage')).toBeLessThan(order.indexOf('entries'));
  });

  it('takes the header path for a file far larger than the header window', () => {
    const saved = store.saveSession(bigSession('Huge', 4_000_000));
    expect(readFileSync(join(sessionsDir, `${saved.id}.json`)).length).toBeGreaterThan(8 * 1024);

    const listed = store.listSavedSessions().find((entry) => entry.id === saved.id);
    expect(listed?.title).toBe('Huge');
    expect(listed?.preview).toBe('last Huge');
  });

  it('falls back to a full parse for a compact session written before the header fields existed', () => {
    const saved = store.saveSession(bigSession('Compact legacy', 2_000));
    const path = join(sessionsDir, `${saved.id}.json`);
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    delete parsed.hasUserMessage;
    delete parsed.preview;
    writeFileSync(path, JSON.stringify(parsed), 'utf8');

    const listed = store.listSavedSessions().find((entry) => entry.id === saved.id);
    expect(listed).toBeDefined();
    expect(listed?.preview).toBe('last Compact legacy');
  });

  it('does not let one unreadable file hide the others', () => {
    const good = store.saveSession(bigSession('Readable', 500));
    writeFileSync(join(sessionsDir, `${randomUUID()}.json`), '{ not json', 'utf8');
    expect(store.listSavedSessions().map((entry) => entry.id)).toContain(good.id);
  });

  it('lists every saved session it wrote', () => {
    const first = store.saveSession(bigSession('First', 500));
    const second = store.saveSession(bigSession('Second', 500));
    const ids = store.listSavedSessions().map((entry) => entry.id);
    expect(ids).toHaveLength(2);
    expect(ids).toContain(first.id);
    expect(ids).toContain(second.id);
  });

  it('does not read the transcript of the sessions it lists', () => {
    const saved = store.saveSession(bigSession('No body read', 4_000_000));
    const path = join(sessionsDir, `${saved.id}.json`);

    readFileSyncSpy.mockClear();
    const listed = store.listSavedSessions();

    expect(listed.map((entry) => entry.id)).toContain(saved.id);
    expect(readFileSyncSpy.mock.calls.filter(([target]) => target === path)).toHaveLength(0);
  });

  it('reads the whole file only for a session that needs the legacy fallback', () => {
    const saved = store.saveSession(bigSession('Needs fallback', 4_000_000));
    const path = join(sessionsDir, `${saved.id}.json`);
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    delete parsed.hasUserMessage;
    writeFileSync(path, JSON.stringify(parsed), 'utf8');

    readFileSyncSpy.mockClear();
    const listed = store.listSavedSessions();

    expect(listed.map((entry) => entry.id)).toContain(saved.id);
    expect(readFileSyncSpy.mock.calls.filter(([target]) => target === path).length).toBeGreaterThan(0);
  });

  it('still loads the full transcript that listing never reads', () => {
    const saved = store.saveSession(bigSession('Full load', 9_000));
    const loaded = store.loadSavedSession(saved.id);
    expect(loaded?.conversation).toHaveLength(1);
    expect(loaded?.entries).toHaveLength(3);
    expect(readdirSync(sessionsDir)).toHaveLength(1);
  });
});
