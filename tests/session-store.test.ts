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
    const path = join(root, 'sessions', saved.id + '.json');
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
