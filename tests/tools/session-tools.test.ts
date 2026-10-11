import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SavedSession, SessionEntry } from '../../src/session-store.js';
import type { ToolDefinition } from '../../src/tools/registry.js';

/**
 * The two read-only session tools are the model-facing half of the registry: session_list browses
 * the rolling metadata, session_read opens one bounded transcript window. Everything here runs
 * against real session files written by the store, so pagination, truncation, and the sha256 are
 * the ones a live daemon would produce.
 */

const uuidQueue = vi.hoisted(() => [] as string[]);
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return { ...actual, randomUUID: () => uuidQueue.shift() ?? actual.randomUUID() };
});

type Store = typeof import('../../src/session-store.js');
type Registry = typeof import('../../src/session-registry.js');

let root: string;
let sessionsDir: string;
let store: Store;
let registry: Registry;
let listTool: ToolDefinition;
let readTool: ToolDefinition;
let searchTool: ToolDefinition;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'ranite-session-tools-'));
  vi.stubEnv('RANITE_DATA_DIR', root);
  vi.resetModules();
  store = await import('../../src/session-store.js');
  registry = await import('../../src/session-registry.js');
  registry.resetSessionActivityForTests();
  const { createSessionListTool } = await import('../../src/tools/session-list.js');
  const { createSessionReadTool } = await import('../../src/tools/session-read.js');
  const { createSessionSearchTool } = await import('../../src/tools/session-search.js');
  listTool = createSessionListTool(root);
  readTool = createSessionReadTool();
  searchTool = createSessionSearchTool(root);
  sessionsDir = join(root, 'sessions');
});

afterEach(() => {
  vi.unstubAllEnvs();
  uuidQueue.length = 0;
  if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith('ranite-session-tools-')) {
    throw new Error('Refusing to remove a directory outside this test fixture.');
  }
  rmSync(root, { recursive: true, force: true });
});

function saveSession(options: { entries: SessionEntry[]; workspace?: string; title?: string }): SavedSession {
  const base = store.createSession('fixture-provider', 'fixture-model', 262_144, options.workspace ?? root);
  return store.saveSession({
    ...base,
    ...(options.title === undefined ? {} : { title: options.title }),
    entries: options.entries,
  });
}

function sessionPath(id: string): string {
  return join(sessionsDir, `${id}.json`);
}

async function run(tool: ToolDefinition, input: Record<string, unknown>): Promise<Record<string, unknown>> {
  return (await tool.execute(input)) as Record<string, unknown>;
}

describe('session_list', () => {
  it('lists every workspace by default with rolling metadata', async () => {
    const here = saveSession({
      title: 'Workspace work',
      entries: [
        { kind: 'user', text: 'first ask' },
        { kind: 'assistant', text: 'first reply' },
        { kind: 'user', text: 'last ask' },
      ],
    });
    const elsewhere = saveSession({
      title: 'Other workspace',
      entries: [{ kind: 'user', text: 'elsewhere' }],
      workspace: join(root, 'other'),
    });

    const result = await run(listTool, {});
    expect(result.status).toBe('completed');
    expect(result.scope).toBe('all');
    expect(result.count).toBe(2);
    expect(result.sessions).toEqual(
      expect.arrayContaining([
        {
          id: here.id,
          title: 'Workspace work',
          workspaceRoot: resolve(root),
          providerId: 'fixture-provider',
          modelId: 'fixture-model',
          status: 'idle',
          createdAt: here.createdAt,
          updatedAt: here.updatedAt,
          firstUserMessage: 'first ask',
          lastUserMessage: 'last ask',
          lastAssistantMessage: 'first reply',
        },
        {
          id: elsewhere.id,
          title: 'Other workspace',
          workspaceRoot: resolve(join(root, 'other')),
          providerId: 'fixture-provider',
          modelId: 'fixture-model',
          status: 'idle',
          createdAt: elsewhere.createdAt,
          updatedAt: elsewhere.updatedAt,
          firstUserMessage: 'elsewhere',
          lastUserMessage: 'elsewhere',
          lastAssistantMessage: '',
        },
      ]),
    );
  });

  it('narrows to the active workspace with scope "workspace"', async () => {
    saveSession({ title: 'Here', entries: [{ kind: 'user', text: 'a' }] });
    saveSession({ title: 'There', entries: [{ kind: 'user', text: 'b' }], workspace: join(root, 'other') });

    const result = await run(listTool, { scope: 'workspace' });
    expect(result.scope).toBe('workspace');
    expect(result.count).toBe(1);
    expect((result.sessions as Array<{ title: string }>).map((session) => session.title)).toEqual(['Here']);
  });

  it('applies the default and explicit limits and rejects invalid input', async () => {
    for (let index = 0; index < 21; index++) {
      saveSession({ title: `Session ${index}`, entries: [{ kind: 'user', text: `question ${index}` }] });
    }
    expect((await run(listTool, {})).count).toBe(20);
    expect((await run(listTool, { limit: 1 })).count).toBe(1);
    expect(await run(listTool, { limit: 0 })).toMatchObject({ status: 'invalid' });
    expect(await run(listTool, { limit: 51 })).toMatchObject({ status: 'invalid' });
    expect(await run(listTool, { limit: 2.5 })).toMatchObject({ status: 'invalid' });
    expect(await run(listTool, { limit: '2' })).toMatchObject({ status: 'invalid' });
    expect(await run(listTool, { scope: 'everywhere' })).toMatchObject({ status: 'invalid' });
  });

  it('reports sessions with a turn running in this process', async () => {
    const saved = saveSession({ title: 'Busy', entries: [{ kind: 'user', text: 'work' }] });
    registry.reportSessionActivity(saved.id, true);
    const result = await run(listTool, {});
    expect((result.sessions as Array<{ status: string }>)[0]?.status).toBe('running');
  });

  it('redacts secrets from the previews it returns', async () => {
    saveSession({ title: 'Secrets', entries: [{ kind: 'user', text: 'password: hunter2' }] });
    const result = await run(listTool, {});
    const serialized = JSON.stringify(result);
    expect(serialized).toContain('password: [redacted]');
    expect(serialized).not.toContain('hunter2');
  });

  it('is a read-only, pre-approved host tool', () => {
    expect(listTool.providerId).toBe('host');
    expect(listTool.name).toBe('session_list');
    expect(listTool.effect).toEqual({
      change: 'none',
      data: 'sensitive',
      network: 'none',
      reversible: 'full',
      outbound: 'model',
    });
    expect(listTool.autoApprove?.({}, undefined)).toBe(true);
  });
});

describe('session_read', () => {
  it('pages display entries with 1-based indices and a continuation offset', async () => {
    const saved = saveSession({
      entries: [
        { kind: 'user', text: 'u1' },
        { kind: 'assistant', text: 'a1' },
        { kind: 'user', text: 'u2' },
        { kind: 'assistant', text: 'a2' },
      ],
    });

    const result = await run(readTool, { session: saved.id, offset: 2, limit: 2 });
    expect(result.status).toBe('completed');
    expect(result.entryCount).toBe(4);
    expect(result.offset).toBe(2);
    expect(result.endOffset).toBe(3);
    expect(result.nextOffset).toBe(4);
    expect(result.truncated).toBe(true);
    expect(result.entries).toEqual([
      { index: 2, kind: 'assistant', text: 'a1' },
      { index: 3, kind: 'user', text: 'u2' },
    ]);
  });

  it('uses the default window of 30 entries', async () => {
    const entries: SessionEntry[] = [];
    for (let index = 0; index < 35; index++) entries.push({ kind: index % 2 === 0 ? 'user' : 'assistant', text: `entry ${index}` });
    const saved = saveSession({ entries });

    const result = await run(readTool, { session: saved.id });
    expect((result.entries as unknown[]).length).toBe(30);
    expect(result.nextOffset).toBe(31);
  });

  it('omits reasoning entries while keeping stable indices over the display transcript', async () => {
    const saved = saveSession({
      entries: [
        { kind: 'user', text: 'question' },
        { kind: 'reasoning', text: 'private thinking' },
        { kind: 'assistant', text: 'answer' },
      ],
    });

    const result = await run(readTool, { session: saved.id });
    expect(result.entryCount).toBe(2);
    expect(JSON.stringify(result.entries)).not.toContain('private thinking');
    expect(result.entries).toEqual([
      { index: 1, kind: 'user', text: 'question' },
      { index: 2, kind: 'assistant', text: 'answer' },
    ]);
  });

  it('centers the window on an entry and clamps at both ends', async () => {
    const saved = saveSession({
      entries: Array.from({ length: 10 }, (_, index) => ({ kind: 'user' as const, text: `entry ${index + 1}` })),
    });

    const centered = await run(readTool, { session: saved.id, around: 5, limit: 3 });
    expect([centered.offset, centered.endOffset, centered.around]).toEqual([4, 6, 5]);
    expect((centered.entries as Array<{ index: number }>).map((entry) => entry.index)).toEqual([4, 5, 6]);

    const atEnd = await run(readTool, { session: saved.id, around: 50, limit: 3 });
    expect([atEnd.offset, atEnd.endOffset]).toEqual([8, 10]);

    const atStart = await run(readTool, { session: saved.id, around: 1, limit: 4 });
    expect([atStart.offset, atStart.endOffset]).toEqual([1, 4]);
  });

  it('rejects conflicting or out-of-range windows', async () => {
    const saved = saveSession({ entries: [{ kind: 'user', text: 'only' }] });
    expect(await run(readTool, { session: saved.id, offset: 1, around: 1 })).toMatchObject({ status: 'invalid' });
    expect(await run(readTool, { session: saved.id, offset: 2 })).toMatchObject({ status: 'invalid', entryCount: 1 });
    expect(await run(readTool, { session: saved.id, offset: 0 })).toMatchObject({ status: 'invalid' });
    expect(await run(readTool, { session: saved.id, around: 0 })).toMatchObject({ status: 'invalid' });
    expect(await run(readTool, { session: saved.id, limit: 101 })).toMatchObject({ status: 'invalid' });
    expect(await run(readTool, { session: saved.id, limit: 0 })).toMatchObject({ status: 'invalid' });
    expect(await run(readTool, { session: '' })).toMatchObject({ status: 'invalid' });
  });

  it('distinguishes malformed, missing, and ambiguous references', async () => {
    const saved = saveSession({ title: 'Reference', entries: [{ kind: 'user', text: 'x' }] });
    expect(await run(readTool, { session: saved.id.slice(0, 8) })).toMatchObject({ status: 'completed' });
    expect((await run(readTool, { session: 'deadbeef' })).status).toBe('not_found');
    expect((await run(readTool, { session: 'zz' })).status).toBe('invalid');

    uuidQueue.push('cccccccc-1111-4111-8111-111111111111', 'cccccccc-2222-4222-8222-222222222222');
    saveSession({ title: 'Twin one', entries: [{ kind: 'user', text: '1' }] });
    saveSession({ title: 'Twin two', entries: [{ kind: 'user', text: '2' }] });
    const ambiguous = await run(readTool, { session: 'cccccccc' });
    expect(ambiguous.status).toBe('ambiguous');
    expect((ambiguous.candidates as unknown[]).length).toBe(2);
  });

  it('reads sessions from other workspaces and reports where they live', async () => {
    const elsewhere = saveSession({ entries: [{ kind: 'user', text: 'other project' }], workspace: join(root, 'other') });
    const result = await run(readTool, { session: elsewhere.id });
    expect(result.status).toBe('completed');
    expect((result.session as { workspaceRoot?: string }).workspaceRoot).toBe(resolve(join(root, 'other')));
  });

  it('projects tool entries as command and result', async () => {
    const saved = saveSession({
      entries: [
        { kind: 'user', text: 'run tests' },
        { kind: 'tool', command: 'npm test', result: 'all green' },
        { kind: 'assistant', text: 'done' },
      ],
    });

    const result = await run(readTool, { session: saved.id });
    expect((result.entries as unknown[])[1]).toEqual({ index: 2, kind: 'tool', command: 'npm test', result: 'all green' });
  });

  it('head-and-tail truncates long tool results with a flag', async () => {
    const long = 'A'.repeat(9_000) + 'B'.repeat(2_000);
    const saved = saveSession({
      entries: [
        { kind: 'user', text: 'run it' },
        { kind: 'tool', command: 'deploy', result: long },
      ],
    });

    const result = await run(readTool, { session: saved.id });
    const entry = (result.entries as Array<Record<string, unknown>>)[1]!;
    expect(entry.resultTruncated).toBe(true);
    const text = entry.result as string;
    expect(text.length).toBe(1_000);
    expect(text.startsWith('A')).toBe(true);
    expect(text.endsWith('B')).toBe(true);
    expect(text).toContain('\n… [middle truncated] …\n');
  });

  it('stops a large window at the size cap and continues from nextOffset', async () => {
    const entries: SessionEntry[] = [];
    for (let index = 0; index < 10; index++) entries.push({ kind: 'user', text: 'x'.repeat(5_000) });
    const saved = saveSession({ entries });

    const first = await run(readTool, { session: saved.id, limit: 10 });
    expect((first.entries as unknown[]).length).toBe(7);
    expect(first.endOffset).toBe(7);
    expect(first.nextOffset).toBe(8);
    expect(first.truncated).toBe(true);

    const rest = await run(readTool, { session: saved.id, offset: 8, limit: 10 });
    expect((rest.entries as Array<{ index: number }>).map((entry) => entry.index)).toEqual([8, 9, 10]);
    expect(rest.nextOffset).toBeUndefined();
  });

  it('hashes the complete session file on disk', async () => {
    const saved = saveSession({ entries: [{ kind: 'user', text: 'hash me' }] });
    const expected = createHash('sha256')
      .update(readFileSync(sessionPath(saved.id)))
      .digest('hex');
    const result = await run(readTool, { session: saved.id });
    expect(result.sha256).toBe(expected);
  });

  it('redacts secrets in entry text and tool results', async () => {
    const saved = saveSession({
      entries: [
        { kind: 'user', text: 'token: abcdef123456' },
        { kind: 'tool', command: 'curl -H "Authorization: Bearer aaa.bbb"', result: 'done' },
      ],
    });

    const result = await run(readTool, { session: saved.id });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('abcdef123456');
    expect(serialized).not.toContain('aaa.bbb');
    const entries = result.entries as Array<Record<string, unknown>>;
    expect(entries[0]?.text).toBe('token: [redacted]');
    expect(entries[1]?.command).toContain('[redacted]');
  });

  it('reports a corrupt transcript as an error instead of guessing', async () => {
    const saved = saveSession({ entries: [{ kind: 'user', text: 'will corrupt' }] });
    const raw = readFileSync(sessionPath(saved.id), 'utf8');
    const marker = raw.indexOf('\n  "entries":');
    writeFileSync(sessionPath(saved.id), raw.slice(0, marker) + '\n  "entries": [broken', 'utf8');

    expect(await run(readTool, { session: saved.id })).toMatchObject({ status: 'error' });
  });

  it('returns an empty transcript for a saved file with no display entries', async () => {
    const id = randomUUID();
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(
      sessionPath(id),
      `${JSON.stringify(
        {
          version: 1,
          id,
          title: 'Reasoning only',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          providerId: 'p',
          modelId: 'm',
          entries: [{ kind: 'reasoning', text: 'thinking' }],
          conversation: [],
        },
        null,
        2,
      )}\n`,
      'utf8',
    );

    const result = await run(readTool, { session: id });
    expect(result).toMatchObject({ status: 'completed', entryCount: 0, endOffset: 0, truncated: false, entries: [] });
  });

  it('is a read-only, pre-approved host tool', () => {
    expect(readTool.providerId).toBe('host');
    expect(readTool.name).toBe('session_read');
    expect(readTool.effect).toEqual({
      change: 'none',
      data: 'sensitive',
      network: 'none',
      reversible: 'full',
      outbound: 'model',
    });
    expect(readTool.autoApprove?.({}, undefined)).toBe(true);
    expect(readTool.inputSchema).toMatchObject({ required: ['session'] });
  });
});

describe('session_search', () => {
  it('finds a message and reports the entry session_read would open', async () => {
    const saved = saveSession({
      entries: [
        { kind: 'user', text: 'investigate the subtitle pipeline' },
        { kind: 'assistant', text: 'the pipeline looks healthy' },
      ],
    });

    const result = await run(searchTool, { query: 'subtitle' });
    expect(result).toMatchObject({ status: 'completed', query: 'subtitle', total: 1 });
    expect(result.indexedSessions).toBe(1);
    const matches = result.matches as Array<Record<string, unknown>>;
    expect(matches[0]).toMatchObject({ sessionId: saved.id, entry: 1, kind: 'user' });

    const read = await run(readTool, { session: matches[0]!.sessionId as string, offset: matches[0]!.entry as number, limit: 1 });
    expect(read).toMatchObject({ status: 'completed', offset: 1 });
    expect((read.entries as Array<Record<string, unknown>>)[0]?.text).toContain('subtitle');
  });

  it('keeps tool outputs out of the default results', async () => {
    saveSession({
      entries: [
        { kind: 'user', text: 'run the suite' },
        { kind: 'tool', command: 'npm test', result: 'outputtoken appeared' },
      ],
    });

    expect(await run(searchTool, { query: 'outputtoken' })).toMatchObject({ status: 'completed', total: 0 });
    const included = await run(searchTool, { query: 'outputtoken', include_outputs: true });
    expect(included.total).toBe(1);
    expect((included.matches as Array<Record<string, unknown>>)[0]).toMatchObject({ entry: 2, kind: 'output' });
  });

  it('narrows scope to the active workspace on request', async () => {
    saveSession({ entries: [{ kind: 'user', text: 'local scope marker' }] });
    saveSession({ entries: [{ kind: 'user', text: 'remote scope marker' }], workspace: join(root, 'other') });

    expect(await run(searchTool, { query: 'scope marker' })).toMatchObject({ total: 2 });
    const narrowed = await run(searchTool, { query: 'scope marker', scope: 'workspace' });
    expect(narrowed.total).toBe(1);
  });

  it('rejects malformed input without touching the index', async () => {
    expect(await run(searchTool, { query: '   ' })).toMatchObject({ status: 'invalid' });
    expect(await run(searchTool, { query: 'ok', limit: 0 })).toMatchObject({ status: 'invalid' });
    expect(await run(searchTool, { query: 'ok', offset: -1 })).toMatchObject({ status: 'invalid' });
    expect(await run(searchTool, { query: 'ok', include_outputs: 'yes' })).toMatchObject({ status: 'invalid' });
  });

  it('is a read-only, pre-approved host tool', () => {
    expect(searchTool.providerId).toBe('host');
    expect(searchTool.name).toBe('session_search');
    expect(searchTool.effect).toEqual({
      change: 'none',
      data: 'sensitive',
      network: 'none',
      reversible: 'full',
      outbound: 'model',
    });
    expect(searchTool.autoApprove?.({}, undefined)).toBe(true);
    expect(searchTool.inputSchema).toMatchObject({ required: ['query'] });
  });
});
