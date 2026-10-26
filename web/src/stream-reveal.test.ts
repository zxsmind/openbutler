import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Root } from 'hast';
import { appendReveal, revealParts, textOffsets } from './stream-reveal.js';
import { rehypeStreamReveal, highlightedStream } from './stream-markdown.js';
import { initialSessionState, sessionReducer } from './session-state.js';
import type { Entry, SessionPayload } from './types.js';

const snapshot = (entries: Entry[]): SessionPayload => ({
  reset: true,
  session: { id: 'test', title: 'Test' },
  entries,
  updated: [],
  from: 0,
  totalEntries: entries.length,
  busy: true,
  queuedMessageCount: 0,
  pendingApproval: null,
  pendingQuestion: null,
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('stream arrival ownership', () => {
  it('animates only appended text; duplicates, rewrites and expired chunks cannot replay', () => {
    const first = appendReveal('old', 'old new', [], 1_000);
    expect(first).toEqual([{ from: 3, to: 7, at: 1_000 }]);
    expect(appendReveal('old new', 'old new', first, 1_050)).toEqual(first);
    expect(appendReveal('old new', 'old new!', first, 1_250)).toEqual([{ from: 7, to: 8, at: 1_250 }]);
    expect(appendReveal('old new', 'replacement', first, 1_050)).toEqual([]);
  });

  it('keeps snapshot/history static and preserves arrival times through batched patches and completion', () => {
    vi.spyOn(performance, 'now').mockReturnValue(1_000);
    const initial = sessionReducer(initialSessionState, { type: 'payload', payload: snapshot([{ kind: 'assistant', text: 'old' }]) });
    expect(initial.entries[0].streamReveal).toBeUndefined();
    const patch = (text: string, busy = true): SessionPayload => ({
      ...snapshot([]),
      reset: false,
      from: 1,
      updated: [{ index: 0, entry: { kind: 'assistant', text } }],
      busy,
    });
    const changed = sessionReducer(initial, {
      type: 'payloads',
      payloads: [patch('old new'), patch('old new!'), patch('old new!', false)].map((payload) => ({ payload, receivedAt: 1_000 })),
    });
    expect(changed.entries[0].streamReveal).toEqual([
      { from: 3, to: 7, at: 1_000 },
      { from: 7, to: 8, at: 1_000 },
    ]);
    const reset = sessionReducer(changed, { type: 'payload', payload: snapshot([{ kind: 'assistant', text: 'old new!' }]) });
    expect(reset.entries[0].streamReveal).toBeUndefined();
    const paged = sessionReducer(reset, {
      type: 'older',
      sessionId: 'test',
      before: 0,
      from: -1,
      entries: [{ kind: 'reasoning', text: 'history' }],
    });
    expect(paged.entries[0].streamReveal).toBeUndefined();
    vi.restoreAllMocks();
  });

  it('shares the same contract for new answers, reasoning and tool output', () => {
    const initial = sessionReducer(initialSessionState, { type: 'payload', payload: snapshot([]) });
    const entries: Entry[] = [
      { kind: 'assistant', text: 'Answer' },
      { kind: 'reasoning', text: 'Thought' },
      { kind: 'tool', result: 'Output' },
      { kind: 'user', text: 'Ask' },
    ];
    const changed = sessionReducer(initial, { type: 'payload', payload: { ...snapshot(entries), reset: false }, receivedAt: 1_000 });
    for (const entry of changed.entries.slice(0, 3))
      expect(entry.streamReveal?.[0]).toMatchObject({ from: 0, to: (entry.text ?? entry.result ?? '').length });
    expect(changed.entries[3].streamReveal).toBeUndefined();
  });
});

describe('source-aware text reveal', () => {
  it('maps escapes, entities, inline code and CRLF without mistaking old text for new text', () => {
    expect(textOffsets('& x', '&amp; x', 10)).toEqual([14, 15, 16]);
    expect(textOffsets('&amp;', '&amp;amp;', 0)).toEqual([4, 5, 6, 7, 8]);
    expect(textOffsets('*ok*', '\\*ok\\*', 0)).toEqual([1, 2, 3, 5]);
    expect(textOffsets('code', '`code`', 5)).toEqual([6, 7, 8, 9]);
    expect(textOffsets('a\nb', 'a\r\nb', 0)).toEqual([0, 2, 3]);
    expect(textOffsets('old\nnew', 'old\n> new', 0)).toEqual([0, 1, 2, 3, 6, 7, 8]);
    expect(textOffsets('  a\nb &amp;', '    a\r\n  b &amp;', 0, true)).toEqual([2, 3, 4, 6, 9, 10, 11, 12, 13, 14, 15]);
    expect(textOffsets('generated', 'unrelated', 0)).toBeNull();
    const parts = revealParts('old new', [0, 1, 2, 3, 4, 5, 6], [{ from: 3, to: 7, at: 1_000 }], 1_020);
    expect(parts).toEqual([
      { text: 'old', offset: 0 },
      { text: ' new', offset: 3, at: 1_000 },
    ]);
    expect(revealParts('old new', [0, 1, 2, 3, 4, 5, 6], [{ from: 3, to: 7, at: 1_000 }], 1_200)).toEqual([{ text: 'old new', offset: 0 }]);
  });

  it('survives a Markdown structural rewrite without fading old emphasis again', () => {
    vi.spyOn(performance, 'now').mockReturnValue(1_100);
    const tree: Root = {
      type: 'root',
      children: [
        {
          type: 'element',
          tagName: 'strong',
          properties: {},
          children: [
            {
              type: 'text',
              value: 'old new',
              position: { start: { line: 1, column: 3, offset: 2 }, end: { line: 1, column: 10, offset: 9 } },
            },
          ],
        },
      ],
    };
    rehypeStreamReveal({ source: '**old new**', ranges: [{ from: 5, to: 11, at: 1_000 }] })(tree);
    expect(tree.children[0]).toMatchObject({
      children: [
        { type: 'text', value: 'old' },
        { type: 'element', tagName: 'span', properties: { dataStreamAt: 1_000 }, children: [{ type: 'text', value: ' new' }] },
      ],
    });
    vi.restoreAllMocks();
  });

  it('composes syntax and arrival spans while preserving exact code and escaping', () => {
    vi.spyOn(performance, 'now').mockReturnValue(1_020);
    const html = renderToStaticMarkup(
      createElement(
        'code',
        null,
        highlightedStream('<span class="hljs-keyword">const</span> x = &quot;&lt;tag&gt;&quot;', [{ from: 10, to: 17, at: 1_000 }]),
      ),
    );
    expect(html).toContain('hljs-keyword');
    expect(html.replace(/<[^>]*>/g, '')).toBe('const x = &quot;&lt;tag&gt;&quot;');
    expect(html).toContain('<span>&quot;&lt;tag&gt;&quot;</span>');
    vi.restoreAllMocks();
  });
});
