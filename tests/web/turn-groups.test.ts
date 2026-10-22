import { describe, expect, it } from 'vitest';
import {
  activeGroupIndex,
  awaitingFirstChunk,
  buildTurns,
  classifyTool,
  formatTokens,
  groupSummary,
  groupTimeline,
  groupSignal,
  reasoningSentences,
  thoughtDuration,
  thoughtHeadline,
  thoughtLabel,
} from '../../web/src/turns.js';
import type { Entry } from '../../web/src/types.js';

function onlyTurn(entries: Entry[]) {
  const [turn] = buildTurns(entries);
  if (!turn) throw new Error('expected a turn');
  return turn;
}

describe('step grouping', () => {
  it('keeps warnings, errors and system notices inside the surrounding work group', () => {
    const entries: Entry[] = [
      { kind: 'user', text: 'Task' },
      { kind: 'reasoning', text: 'Thinking' },
      { kind: 'notice', tone: 'warn', text: 'Retrying' },
      { kind: 'tool', command: 'read a.ts', result: 'ok' },
      { kind: 'error', text: 'Request failed' },
      { kind: 'system', text: 'Recovered' },
      { kind: 'tool', command: 'read b.ts', result: 'ok' },
    ];
    const groups = groupTimeline(onlyTurn(entries));
    expect(groups).toEqual([{ kind: 'steps', entries: entries.slice(1) }]);
    expect(activeGroupIndex(groups, true)).toBe(0);
    entries.push({ kind: 'assistant', text: 'Answer' });
    expect(groupTimeline(onlyTurn(entries)).map((group) => group.kind)).toEqual(['steps', 'message']);
    expect(activeGroupIndex(groupTimeline(onlyTurn(entries)), true)).toBe(-1);
  });

  it('labels a diagnostics-only group without inventing thinking work', () => {
    const groups = groupTimeline(onlyTurn([{ kind: 'error', text: 'Connection failed' }]));
    expect(groups).toHaveLength(1);
    const entries = groups[0]?.kind === 'steps' ? groups[0].entries : [];
    expect(groupSummary(entries)).toBe('Notifications');
    expect(groupSignal(entries, '')).toEqual({ kind: 'summary', text: 'Notifications' });
  });

  it('keeps consecutive steps together and starts a new group after a message', () => {
    const groups = groupTimeline(
      onlyTurn([
        { kind: 'user', text: 'Task' },
        { kind: 'reasoning', text: 'thinking', durationMs: 1_000 },
        { kind: 'tool', command: 'read a.ts', result: 'ok' },
        { kind: 'assistant', text: 'First' },
        { kind: 'tool', command: 'read b.ts', result: 'ok' },
      ]),
    );
    expect(groups.map((group) => group.kind)).toEqual(['steps', 'message', 'steps']);
    const [first] = groups;
    expect(first?.kind === 'steps' ? first.entries.map((entry) => entry.kind) : null).toEqual(['reasoning', 'tool']);
  });

  it('opens only the newest group of the newest turn', () => {
    const entries: Entry[] = [
      { kind: 'user', text: 'Task' },
      { kind: 'tool', command: 'a', result: '' },
    ];
    expect(activeGroupIndex(groupTimeline(onlyTurn(entries)), true)).toBe(0);
    entries.push({ kind: 'assistant', text: 'More' }, { kind: 'tool', command: 'b', result: '' });
    const later = groupTimeline(onlyTurn(entries));
    // The group that was open is superseded, so the reader never sees two open groups.
    expect(activeGroupIndex(later, true)).toBe(2);
  });

  it('folds the work the moment the answer starts streaming after it', () => {
    const groups = groupTimeline(
      onlyTurn([
        { kind: 'user', text: 'Task' },
        { kind: 'tool', command: 'a', result: '' },
        { kind: 'assistant', text: 'Answer' },
      ]),
    );
    expect(groups.map((group) => group.kind)).toEqual(['steps', 'message']);
    // The answer is the newest thing in the turn, so the log of how it was
    // produced is history and stays folded while the text streams.
    expect(activeGroupIndex(groups, true)).toBe(-1);
  });

  it('keeps a message sent into a running turn inside that turn', () => {
    const turns = buildTurns([
      { kind: 'user', text: 'First', turnId: 't1' },
      { kind: 'tool', command: 'a', result: '', turnId: 't1' },
      { kind: 'user', text: 'Also this', turnId: 't1' },
      { kind: 'tool', command: 'b', result: '', turnId: 't1' },
    ]);
    expect(turns).toHaveLength(1);
    expect(turns[0]?.user?.text).toBe('First');
    expect(turns[0]?.timeline.map((entry) => entry.kind)).toEqual(['tool', 'user', 'tool']);
  });

  it('keeps turn ids unique when the transcript reuses one', () => {
    const turns = buildTurns([
      { kind: 'user', text: 'First', turnId: 'same' },
      { kind: 'tool', command: 'a', result: '', turnId: 'same' },
      { kind: 'user', text: 'Second', turnId: 'other' },
      { kind: 'user', text: 'Third', turnId: 'same' },
    ]);
    expect(turns).toHaveLength(3);
    expect(new Set(turns.map((turn) => turn.id)).size).toBe(3);
  });

  it('leaves every group folded in a turn that is no longer the newest', () => {
    const groups = groupTimeline(
      onlyTurn([
        { kind: 'user', text: 'Task' },
        { kind: 'tool', command: 'a', result: '' },
      ]),
    );
    expect(activeGroupIndex(groups, false)).toBe(-1);
  });
});

describe('group summary', () => {
  const tool = (identity: string, command: string, extra: Partial<Entry> = {}): Entry => ({
    kind: 'tool',
    tool: identity,
    command,
    result: '',
    ...extra,
  });

  it('places an entry in the turn it names, not the turn it follows', () => {
    // A late thought can land in the array after the next message; its turn id
    // still says which turn it belongs to, and position alone got that wrong.
    const entries = [
      { kind: 'user', text: 'first', turnId: 't1' },
      { kind: 'assistant', text: 'a1', turnId: 't1' },
      { kind: 'user', text: 'second', turnId: 't2' },
      { kind: 'reasoning', text: 'late thought', turnId: 't1' },
      { kind: 'assistant', text: 'a2', turnId: 't2' },
    ] as never[];
    const turns = buildTurns(entries);
    expect(turns).toHaveLength(2);
    expect(turns[0]!.steps.map((entry) => entry.text)).toEqual(['late thought']);
    expect(turns[1]!.timeline.map((entry) => entry.kind)).toEqual(['assistant']);
  });

  it('gives a compaction its own row instead of folding it into the work', () => {
    const entries = [
      { kind: 'user', text: 'go', turnId: 't1' },
      { kind: 'tool', command: 'ls', result: 'ok', turnId: 't1' },
      { kind: 'compaction', status: 'done', beforeTokens: 784_400, afterTokens: 126_900, turnId: 't1' },
      { kind: 'assistant', text: 'done', turnId: 't1' },
    ] as never[];
    const groups = groupTimeline(buildTurns(entries)[0]!);
    expect(groups.map((group) => group.kind)).toEqual(['steps', 'compaction', 'message']);
  });

  it('sizes a token count so a reader can compare two of them', () => {
    expect(formatTokens(784_400)).toBe('784.4k');
    expect(formatTokens(126_900)).toBe('126.9k');
    expect(formatTokens(1_500_000)).toBe('1.5M');
    expect(formatTokens(940)).toBe('940');
  });

  it('counts what the group actually ran', () => {
    expect(groupSummary([tool('host:execute_command', 'git status'), tool('host:execute_command', 'npm test')])).toBe('2 commands run');
  });

  it('says what is running before what finished', () => {
    expect(groupSummary([tool('host:execute_command', 'a', { result: 'ok' }), tool('host:execute_command', 'b', { running: true })])).toBe(
      '1 command running, 1 command run',
    );
  });

  it('names images and skills by what the read was', () => {
    expect(groupSummary([tool('host:file_read', 'Read C:\\shot\\screen.png')])).toBe('1 image loaded');
    expect(groupSummary([tool('host:file_read', 'Read C:\\repo\\skills\\x\\SKILL.md')])).toBe('1 skill read');
    expect(groupSummary([tool('host:file_read', 'Read C:\\repo\\src\\app.ts')])).toBe('1 file read');
  });

  it('classifies the families it is meant to tell apart', () => {
    expect(classifyTool(tool('host:file_edit', 'Edit a.ts'))).toBe('write');
    expect(classifyTool(tool('host:grep', 'grep foo'))).toBe('search');
    expect(classifyTool(tool('host:team_send', 'team_send'))).toBe('team');
    expect(classifyTool(tool('mcp-playwright:browser_navigate', 'navigate'))).toBe('browser');
    expect(classifyTool(tool('mcp-athena:athena_search', 'search'))).toBe('tool');
  });

  it('falls back to the thinking time for a group with no tools', () => {
    expect(groupSummary([{ kind: 'reasoning', text: 'a', durationMs: 2_000 }])).toBe('Thought for 2.0s');
  });
});

describe('open group signal', () => {
  const tool = (command: string, extra: Partial<Entry> = {}): Entry => ({
    kind: 'tool',
    tool: 'host:execute_command',
    command,
    result: '',
    ...extra,
  });

  it('prefers the command that is running now', () => {
    expect(groupSignal([tool('git status', { result: 'ok' }), tool('npm test', { running: true })], 'A headline sentence.')).toEqual({
      kind: 'command',
      text: 'npm test',
    });
  });

  it('shows the thought while it streams and nothing is running', () => {
    expect(groupSignal([tool('git status', { result: 'ok' })], 'A headline sentence.')).toEqual({
      kind: 'headline',
      text: 'A headline sentence.',
    });
  });

  it('falls back to the command that ran last', () => {
    expect(groupSignal([tool('git status', { result: 'ok' }), tool('npm test', { result: 'ok' })], '')).toEqual({
      kind: 'command',
      text: 'npm test',
    });
  });

  it('says the thinking time when the group has no tools', () => {
    expect(groupSignal([{ kind: 'reasoning', text: 'a', durationMs: 2_000 }], '')).toEqual({
      kind: 'summary',
      text: 'Thought for 2.0s',
    });
  });
});

describe('thought headline', () => {
  it('prefers recent topic continuity over an unrelated last sentence', () => {
    const action = 'Checking the session binding before switching the workspace root.';
    expect(
      thoughtHeadline(
        ['The session binding controls the workspace root.', action, 'Actually, that should probably be enough for now.'].join(' '),
      ),
    ).toBe(action);
  });

  it('uses the same statistical selection for a non-English sentence', () => {
    const action = 'Comprobando el registro de la sesión antes de cambiar la carpeta de trabajo.';
    expect(
      thoughtHeadline(
        ['El registro de la sesión determina la carpeta de trabajo.', action, 'Bueno, creo que por ahora es suficiente.'].join(' '),
      ),
    ).toBe(action);
  });

  it('rejects technical and symbol-bearing candidates before ranking them', () => {
    const plain = 'Checking the session binding before switching the workspace root.';
    const technical = [
      'Checking the session binding → switching the workspace root.',
      'Checking the session binding (and switching the workspace root).',
      'Checking the `sessionBinding` before switching the workspace root.',
      'Checking the **session binding** before switching the workspace root.',
      'Checking the session_binding before switching the workspace root.',
      'Checking api.ts before switching the workspace root.',
      'Checking C:\\workspace before switching the workspace root.',
      'Checking the [session binding] before switching the workspace root.',
      'Checking the session binding ✓ before switching the workspace root.',
      'Checking https://example.test before switching the workspace root.',
    ];
    for (const sentence of technical) {
      expect(reasoningSentences(sentence)).toEqual([]);
      expect(thoughtHeadline(`${plain}\n\n${sentence}`)).toBe(plain);
    }
  });

  it('preserves normal prose punctuation without stripping signs from technical text', () => {
    const plain = "We're checking the session binding, then switching the workspace root.";
    expect(thoughtHeadline(plain)).toBe(plain);
    expect(thoughtHeadline('The session binding → the workspace root.')).toBe('');
  });

  it('ignores fenced code, questions and the incomplete streaming suffix', () => {
    const complete = 'Checking the session binding before switching the workspace root.';
    expect(
      reasoningSentences(
        `${complete}\n\n\`\`\`ts\nThis looks like a complete prose sentence.\n\`\`\`\n\nWhat should happen after the next request? Now checking the`,
      ),
    ).toEqual([complete]);
  });

  it('accepts readable lowercase prose without shortening the sentence', () => {
    const sentence = 'checking the session binding before switching the workspace root.';
    expect(thoughtHeadline(sentence)).toBe(sentence);
  });

  it('does not change the selected sentence when another sentence is still streaming', () => {
    const text = 'The session binding controls the workspace root. Checking the session binding before switching the workspace root.';
    expect(thoughtHeadline(`${text} An incomplete addition that keeps growing`)).toBe(thoughtHeadline(text));
  });

  it('shows the newest sentence that reads well', () => {
    expect(thoughtHeadline("I'm going in circles again. Let me use the data: the sampler now records group positions AND labels.")).toBe(
      'Let me use the data: the sampler now records group positions AND labels.',
    );
  });

  it('advances to the newest sentence that reads well', () => {
    const opening = 'I am checking the measured group positions before comparing the streamed response lengths.';
    expect(thoughtHeadline(opening)).toBe(opening);
    const next = 'The recorded response lengths will be compared against the entries received from the host.';
    expect(thoughtHeadline(`${opening} ${next}`)).toBe(next);
  });

  it('never shows a sentence that is still being written', () => {
    expect(thoughtHeadline('Done. Now checking the group header')).toBe('');
  });

  it('skips fragments too short to read as a sentence', () => {
    expect(reasoningSentences('Ok. Fine. Done.')).toEqual([]);
  });

  it('skips lines shaped like code', () => {
    expect(reasoningSentences('Use `const x = 1` right here.')).toEqual([]);
  });

  it('keeps every decent sentence, in order', () => {
    const first = 'The sampler now records the current group positions together with the displayed labels.';
    const second = 'Then, after my answer streams, I compare rendered lengths against host entries.';
    expect(reasoningSentences(`${first} ${second}`)).toEqual([first, second]);
  });

  it('preserves long complete sentences instead of creating a clipped fragment', () => {
    const sentence =
      'After the answer finishes streaming, I compare the rendered response lengths against the original host entries to identify where the visible content was lost.';
    expect(thoughtHeadline(sentence)).toBe(sentence);
  });

  it('does not fall back to a short sentence when no long prose candidate exists', () => {
    expect(thoughtHeadline("I'm going in circles again. That should be enough for now.")).toBe('');
  });
});

describe('thinking time', () => {
  it('names the duration in the label', () => {
    expect(thoughtLabel(11_600)).toBe('Thought for 11.6s');
    expect(thoughtLabel(75_000)).toBe('Thought for 1m 15s');
    expect(thoughtLabel(undefined)).toBe('Thought');
  });

  it('sums a group and stays unknown while one block is unstamped', () => {
    expect(
      thoughtDuration([
        { kind: 'reasoning', text: 'a', durationMs: 1_000 },
        { kind: 'reasoning', text: 'b', durationMs: 500 },
      ]),
    ).toBe(1_500);
    expect(
      thoughtDuration([
        { kind: 'reasoning', text: 'a', durationMs: 1_000 },
        { kind: 'reasoning', text: 'b' },
      ]),
    ).toBeUndefined();
    expect(thoughtDuration([{ kind: 'tool', command: 'a', result: '' }])).toBeUndefined();
  });
});

describe('compaction output', () => {
  // The checkpoint the model writes is stored so the record stays complete, but
  // it is not part of the conversation: the reader gets the row, not 30k of
  // summary prose that looks like an answer.
  it('shows the compaction row and drops the text the machinery wrote', () => {
    const entries: Entry[] = [
      { kind: 'user', text: 'Task' },
      { kind: 'compaction', status: 'done', beforeTokens: 784_400, afterTokens: 126_900, at: 1 },
      { kind: 'reasoning', text: 'Checkpoint thinking', internal: 'compaction' },
      { kind: 'assistant', text: '## Objective and current request', internal: 'compaction' },
      { kind: 'tool', command: 'read a.ts', result: 'ok' },
      { kind: 'assistant', text: 'Answer' },
    ];
    const turn = onlyTurn(entries);
    expect(turn.user?.text).toBe('Task');
    expect(turn.timeline.map((entry) => entry.kind)).toEqual(['compaction', 'tool', 'assistant']);
    expect(turn.assistant.map((entry) => entry.text)).toEqual(['Answer']);
    expect(groupTimeline(turn).map((group) => group.kind)).toEqual(['compaction', 'steps', 'message']);
  });

  it('keeps unmarked assistant text, even when a compaction row precedes it', () => {
    const entries: Entry[] = [
      { kind: 'user', text: 'Task' },
      { kind: 'compaction', status: 'failed', at: 1 },
      { kind: 'assistant', text: 'Answer after a failed compaction' },
    ];
    const turn = onlyTurn(entries);
    expect(turn.assistant.map((entry) => entry.text)).toEqual(['Answer after a failed compaction']);
  });
});

describe('typing dot window', () => {
  it('shows only between the owner message and the first chunk', () => {
    const asked: Entry[] = [{ kind: 'user', text: 'Task', turnId: 'turn-1' }];
    const turns = buildTurns(asked);
    expect(awaitingFirstChunk(turns, 'turn-1')).toBe(true);
    // The first chunk is the feedback; the dot has nothing left to say.
    const streaming = buildTurns([...asked, { kind: 'reasoning', text: 'Thinking', turnId: 'turn-1' }]);
    expect(awaitingFirstChunk(streaming, 'turn-1')).toBe(false);
    // Nothing is running, so nothing is awaited.
    expect(awaitingFirstChunk(turns, undefined)).toBe(false);
  });
});
