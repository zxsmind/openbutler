import { mkdtempSync, readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { expect, it, vi } from 'vitest';
import type { ModelMessage } from 'ai';
import { COMPACTION_CONTINUE_MESSAGE, COMPACTION_SUMMARY_MARKER, TOOL_REFERENCE_MARKER } from '../src/conversation.js';

it('restores legacy queue ordering and checkpoint projection while keeping every raw archive message', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ranite-session-migration-'));
  if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith('ranite-session-migration-'))
    throw new Error('Unsafe migration fixture path.');
  vi.stubEnv('RANITE_DATA_DIR', root);
  vi.resetModules();
  try {
    const { createSession, saveSession, loadSavedSession } = await import('../src/session-store.js');
    const preview = (id: string): ModelMessage => ({
      role: 'assistant',
      content:
        TOOL_REFERENCE_MARKER +
        JSON.stringify({ batchId: id, toolCallId: id, toolName: 'inspect', input: 'input', outputType: 'text', output: 'output' }),
    });
    const user: ModelMessage = { role: 'user', content: 'Exact original message' };
    const call: ModelMessage = {
      role: 'assistant',
      content: [{ type: 'tool-call', toolCallId: 'actual', toolName: 'inspect', input: {} }],
    };
    const queued: ModelMessage = {
      role: 'user',
      content: [{ type: 'text', text: 'Queued correction' }],
      providerOptions: { ranite: { queuedMessageId: 'correction' } },
    };
    const result: ModelMessage = {
      role: 'tool',
      content: [{ type: 'tool-result', toolCallId: 'actual', toolName: 'inspect', output: { type: 'text', value: 'Exact result' } }],
    };
    const conversation: ModelMessage[] = [
      {
        role: 'assistant',
        content: COMPACTION_SUMMARY_MARKER + 'Successful checkpoint',
        providerOptions: { ranite: { compactionCheckpoint: true } },
      },
      user,
      preview('old'),
      preview('latest'),
      COMPACTION_CONTINUE_MESSAGE,
      call,
      queued,
      result,
    ];
    const saved = saveSession({
      ...createSession('fixture', 'fixture', 262_144, root),
      entries: [{ kind: 'user', text: 'Exact original message' }],
      conversation,
      conversationArchive: [...conversation],
      contextTokens: 190_000,
      contextEstimateTokens: 140_000,
    });
    const path = join(root, 'sessions', saved.id, saved.id + '.json');
    const originalFile = readFileSync(path, 'utf8');
    const restored = loadSavedSession(saved.id)!;
    expect(restored.conversation).not.toContainEqual(preview('old'));
    expect(restored.conversation.slice(-3)).toEqual([queued, call, result]);
    expect(restored.conversationArchive!.slice(-3)).toEqual([queued, call, result]);
    expect(restored.conversationArchive).toHaveLength(conversation.length);
    expect(restored.conversationArchive).toContainEqual(preview('old'));
    expect(restored.contextTokens).toBeUndefined();
    expect(readFileSync(path, 'utf8')).toBe(originalFile);
  } finally {
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  }
});

it('saves and reloads a session carrying every user-entry source, including team', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ranite-session-sources-'));
  if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith('ranite-session-sources-'))
    throw new Error('Unsafe fixture path.');
  vi.stubEnv('RANITE_DATA_DIR', root);
  vi.resetModules();
  try {
    const { createSession, saveSession, loadSavedSession, USER_ENTRY_SOURCES } = await import('../src/session-store.js');
    // Every source the type allows must survive the save validator; a source
    // added to one and forgotten in the other once made a session unsavable.
    const entries = USER_ENTRY_SOURCES.map((source) => ({ kind: 'user' as const, text: `from ${source}`, source }));
    const keyPositions = { ['a'.repeat(64)]: 1 };
    const saved = saveSession({ ...createSession('fixture', 'fixture', 262_144, root), entries, keyPositions });
    const restored = loadSavedSession(saved.id)!;
    expect(restored.entries.map((entry) => (entry.kind === 'user' ? entry.source : null))).toEqual([...USER_ENTRY_SOURCES]);
    expect(restored.keyPositions).toEqual(keyPositions);
    expect(createSession('fixture', 'fixture').keyPositions ?? {}).toEqual({});
  } finally {
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  }
});

it('keeps a compaction row through save and load', async () => {
  // A new entry kind that the validator does not know makes the whole session
  // file unreadable, which is worse than the row itself going missing.
  const root = mkdtempSync(join(tmpdir(), 'ranite-session-compaction-'));
  vi.stubEnv('RANITE_DATA_DIR', root);
  vi.resetModules();
  try {
    const { createSession, saveSession, loadSavedSession } = await import('../src/session-store.js');
    const entries = [
      { kind: 'user' as const, text: 'long task' },
      { kind: 'compaction' as const, status: 'done' as const, beforeTokens: 784_400, afterTokens: 126_900 },
    ];
    const saved = saveSession({ ...createSession('fixture', 'fixture', 262_144, root), entries });
    const restored = loadSavedSession(saved.id)!;
    expect(restored.entries[1]).toMatchObject({ kind: 'compaction', status: 'done', beforeTokens: 784_400, afterTokens: 126_900 });
  } finally {
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  }
});

it('keeps a divider row through save and load', async () => {
  // Dividers are backend-written transcript facts; a validator that drops them
  // would silently erase settings changes and day boundaries on reload.
  const root = mkdtempSync(join(tmpdir(), 'ranite-session-divider-'));
  vi.stubEnv('RANITE_DATA_DIR', root);
  vi.resetModules();
  try {
    const { createSession, saveSession, loadSavedSession } = await import('../src/session-store.js');
    const entries = [
      { kind: 'divider' as const },
      { kind: 'divider' as const, text: 'Wednesday 03:49' },
      { kind: 'user' as const, text: 'after the boundary' },
    ];
    const saved = saveSession({ ...createSession('fixture', 'fixture', 262_144, root), entries });
    const restored = loadSavedSession(saved.id)!;
    expect(restored.entries[0]).toMatchObject({ kind: 'divider' });
    expect(restored.entries[0]).not.toHaveProperty('text');
    expect(restored.entries[1]).toMatchObject({ kind: 'divider', text: 'Wednesday 03:49' });
  } finally {
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  }
});

it('keeps the compaction marker through save and load', async () => {
  // The marker decides whether the reader sees the checkpoint prose, so dropping
  // it on reload would put the whole summary back into the conversation.
  const root = mkdtempSync(join(tmpdir(), 'ranite-session-internal-'));
  vi.stubEnv('RANITE_DATA_DIR', root);
  vi.resetModules();
  try {
    const { createSession, saveSession, loadSavedSession } = await import('../src/session-store.js');
    const entries = [
      { kind: 'user' as const, text: 'long task' },
      { kind: 'assistant' as const, text: '## Objective and current request', internal: 'compaction' as const },
    ];
    const saved = saveSession({ ...createSession('fixture', 'fixture', 262_144, root), entries });
    const restored = loadSavedSession(saved.id)!;
    expect(restored.entries[1]).toMatchObject({ kind: 'assistant', internal: 'compaction' });
  } finally {
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  }
});

it('persists full tool input once and still loads legacy command entries', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ranite-tool-input-'));
  if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith('ranite-tool-input-'))
    throw new Error('Unsafe fixture path.');
  vi.stubEnv('RANITE_DATA_DIR', root);
  vi.resetModules();
  try {
    const { createSession, saveSession, loadSavedSession } = await import('../src/session-store.js');
    const entries = [
      { kind: 'tool' as const, tool: 'host:file_write', input: { path: 'a.ts', content: 'long input '.repeat(1000) }, result: 'Done' },
      { kind: 'tool' as const, command: 'legacy command', result: 'legacy result' },
    ];
    const saved = saveSession({ ...createSession('fixture', 'fixture', 262_144, root), entries }, { allowEmpty: true });
    expect(loadSavedSession(saved.id)!.entries).toEqual(entries);
    expect(loadSavedSession(saved.id)!.entries[0]).not.toHaveProperty('command');
  } finally {
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  }
});
