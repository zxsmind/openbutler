import { describe, expect, it } from 'vitest';
import { formatToolResult, toolDisplayCommand, toolPreviewCommand } from '../src/agent-session.js';

const host = (name: string, input: Record<string, unknown> = {}) => ({ providerId: 'host', name, input });
const display = (name: string, value: unknown) => formatToolResult({ providerId: 'host', name }, value).text;

describe('tool display commands', () => {
  it('names reads, writes, and edits with their paths', () => {
    expect(toolDisplayCommand(host('file_read', { path: 'a/b.ts' }))).toBe('Read a/b.ts');
    expect(toolDisplayCommand(host('file_read', { path: 'a/b.ts', offset: 10, limit: 30 }))).toBe('Read a/b.ts:10-39');
    expect(toolDisplayCommand(host('file_write', { path: 'a.ts', content: 'x\nY' }))).toBe('Write a.ts');
    expect(toolDisplayCommand(host('file_write', { path: 'a.ts', content: 'x' }))).toBe('Write a.ts');
    expect(toolDisplayCommand(host('file_edit', { path: 'a.ts', old: 'foo()', new: 'bar()' }))).toBe('Edit a.ts');
    expect(toolDisplayCommand(host('file_edit', { path: 'a.ts', old: 'a\nb', new: 'c' }))).toBe('Edit a.ts');
  });

  it('keeps raw commands and search patterns readable', () => {
    expect(toolDisplayCommand(host('execute_command', { command: 'npm run check' }))).toBe('npm run check');
    expect(toolDisplayCommand(host('glob', { pattern: 'src/**/*.ts' }))).toBe('Glob src/**/*.ts');
    expect(toolDisplayCommand(host('grep', { pattern: 'todo', path: 'src' }))).toBe('Grep todo in src');
  });

  it('summarizes questions, searches, sessions, and workers without JSON', () => {
    expect(toolDisplayCommand(host('question', { question: 'Deploy now?', options: ['yes', 'no'] }))).toBe('Ask "Deploy now?" [yes · no]');
    expect(toolDisplayCommand(host('memory_search', { query: 'release notes' }))).toBe('Search memory "release notes"');
    expect(toolDisplayCommand(host('session_list', {}))).toBe('Sessions all · 20');
    expect(toolDisplayCommand(host('session_list', { scope: 'workspace', limit: 5 }))).toBe('Sessions workspace · 5');
    expect(toolDisplayCommand(host('session_search', { query: 'power issue' }))).toBe('Search sessions "power issue"');
    expect(toolDisplayCommand(host('session_read', { session: '5b3fc43e-xxxx', offset: 580, limit: 68 }))).toBe(
      'Read session 5b3fc43e:580-647',
    );
    expect(toolDisplayCommand(host('session_message', { session: 'abc123', text: 'hold on' }))).toBe('Message abc123 "hold on"');
    expect(toolDisplayCommand(host('parent_message', { text: 'halfway done' }))).toBe('Note "halfway done"');
    expect(toolDisplayCommand(host('subagent', { mode: 'explorer', task: 'find the bug' }))).toBe('subagent explorer · find the bug');
    expect(toolDisplayCommand(host('subagent_poll', { session: 'abcdef12-3456' }))).toBe('Poll abcdef12');
    expect(toolDisplayCommand(host('subagent_stop', { session: 'abcdef12-3456' }))).toBe('Stop abcdef12');
    expect(toolDisplayCommand(host('schedule', { action: 'list' }))).toBe('Schedule list');
  });

  it('falls back to a bounded input summary for unknown tools', () => {
    expect(toolDisplayCommand(host('mystery', { a: 1 }))).toBe('host/mystery {"a":1}');
    expect(toolDisplayCommand({ providerId: 'mcp', name: 'thing', input: { x: 'y' } })).toBe('mcp/thing {"x":"y"}');
  });
});

describe('tool preview commands', () => {
  it('picks the meaningful streamed field instead of the first one', () => {
    const fields = [
      { key: 'limit', value: '34' },
      { key: 'session', value: '5b3fc43e' },
    ];
    expect(toolPreviewCommand('host', 'session_read', fields)).toBe('Read session 5b3fc43e');
    expect(toolPreviewCommand('host', 'session_search', [{ key: 'query', value: 'power' }])).toBe('Search sessions "power"');
    expect(toolPreviewCommand('host', 'question', [{ key: 'question', value: 'Ship it?' }])).toBe('Ask "Ship it?"');
    expect(toolPreviewCommand('host', 'subagent', [])).toBe('subagent');
    expect(toolPreviewCommand('host', 'subagent_poll', [{ key: 'session', value: 'abcdef12' }])).toBe('Poll abcdef12');
  });
});

describe('tool result display', () => {
  it('shows write and edit stats without metadata', () => {
    expect(
      display('file_write', {
        status: 'completed',
        path: 'a.ts',
        created: false,
        addedLines: 34,
        removedLines: 43,
      }),
    ).toBe('(+34 -43)');
    expect(display('file_write', { status: 'completed', path: 'a.ts', created: true, addedLines: 3, removedLines: 0 })).toBe('(+3 -0)');
    expect(display('file_edit', { status: 'completed', path: 'a.ts', line: 12, addedLines: 1, removedLines: 1 })).toBe('(+1 -1)');
    expect(display('file_write', { status: 'denied', error: 'locked by a worker' })).toBe('locked by a worker');
  });

  it('shows file content first with a line header', () => {
    expect(display('file_read', { status: 'completed', path: 'a.ts', offset: 1, endLine: 2, content: 'x\nY' })).toBe(
      'a.ts · lines 1–2\nx\nY',
    );
    expect(
      display('file_read', {
        status: 'completed',
        path: 'src',
        entries: [
          { name: 'a.ts', type: 'file' },
          { name: 'sub', type: 'directory' },
        ],
        totalEntries: 2,
      }),
    ).toBe('src · 2 entries\na.ts\nsub/');
  });

  it('surfaces exit codes and counts for commands and searches', () => {
    expect(display('execute_command', { status: 'completed', exitCode: 0, stdout: 'ok', stderr: '' })).toBe('ok');
    expect(display('execute_command', { status: 'completed', exitCode: 1, stdout: '', stderr: 'boom' })).toBe('exit 1\nboom');
    expect(display('glob', { status: 'completed', files: ['a', 'b'], count: 2, truncated: false })).toBe('2 files\na\nb');
    expect(
      display('grep', {
        status: 'completed',
        matches: [{ path: 'a.ts', line: 3, text: '  todo fix' }],
        truncated: false,
      }),
    ).toBe('1 match\na.ts:3: todo fix');
  });

  it('compacts session and memory results', () => {
    expect(
      display('session_list', {
        status: 'completed',
        scope: 'all',
        sessions: [{ id: '5b3fc43e-1234', title: 'Hello', updatedAt: '2026-10-11T03:44:00.000Z' }],
      }),
    ).toBe('1 session (all)\n- Hello (5b3fc43e · 2026-10-11 03:44)');
    expect(
      display('session_search', {
        status: 'completed',
        query: 'power',
        total: 1,
        matches: [{ sessionId: 'abc', title: 'T', entry: 7, snippet: 'found it here' }],
      }),
    ).toBe('1 match for "power"\n- T #7: found it here');
    expect(
      display('session_read', {
        status: 'completed',
        session: { id: 'abc123', title: 'T' },
        entryCount: 2,
        offset: 1,
        endOffset: 2,
        entries: [
          { index: 1, kind: 'user', text: 'hi' },
          { index: 2, kind: 'tool', command: 'npm test', result: 'all green\nmore' },
        ],
      }),
    ).toBe('Session T (abc123) · 1–2 of 2\nhi\n› npm test → all green');
    expect(
      display('memory_search', {
        status: 'completed',
        query: 'rel',
        matches: [{ title: 'N', path: 'user/n.md', snippet: 'body text' }],
      }),
    ).toBe('1 note for "rel"\n- N (user/n.md): body text');
    expect(display('memory_search', { status: 'no_matches', query: 'rel', matches: [] })).toBe(
      '{\n  "status": "no_matches",\n  "query": "rel",\n  "matches": []\n}',
    );
  });

  it('passes through answers, reports, errors, and unknown shapes', () => {
    expect(display('question', { status: 'answered', question: 'Q?', answer: 'Yes' })).toBe('Yes');
    expect(display('subagent', { status: 'completed', report: 'Done.' })).toBe('Done.');
    expect(display('subagent', { status: 'started', session: 'abcdef12', mode: 'explorer' })).toBe('Started explorer worker (abcdef12)');
    expect(
      display('subagent_poll', {
        status: 'running',
        session: 'abcdef12',
        elapsedSec: 5,
        toolCalls: 2,
        lastTool: 'host:file_read',
        notes: ['halfway there'],
      }),
    ).toBe('Running (abcdef12) · 5s · 2 calls · file_read\n- halfway there');
    expect(display('subagent_poll', { status: 'finished', session: 'abcdef12', report: 'Done.', error: 'Run cancelled.' })).toBe(
      'Finished (abcdef12)\nDone.\n! Run cancelled.',
    );
    expect(display('subagent_stop', { status: 'stopped', session: 'abcdef12' })).toBe('Stopped worker (abcdef12)');
    expect(display('file_read', { status: 'invalid', error: 'path must be a file.' })).toBe('path must be a file.');
    expect(display('mystery', { status: 'completed', detail: 'Fixture result' })).toBe(
      '{\n  "status": "completed",\n  "detail": "Fixture result"\n}',
    );
  });
});
