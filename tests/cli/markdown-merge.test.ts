import type { Tokens } from 'marked';
import { describe, expect, it } from 'vitest';
import { mergeMarkdownTokenSegments } from '../../src/cli/markdown-merge.js';

function orderedList(start: number, labels: string[]): Tokens.List {
  return {
    type: 'list',
    raw: labels.map((label, index) => `${start + index}. ${label}`).join('\n\n'),
    ordered: true,
    start,
    loose: false,
    items: labels.map(
      (label, index) =>
        ({
          type: 'list_item',
          raw: `${start + index}. ${label}`,
          text: label,
          tokens: [],
        }) as unknown as Tokens.ListItem,
    ),
  } as unknown as Tokens.List;
}

describe('mergeMarkdownTokenSegments', () => {
  it('never mutates the previous token array or its tokens', () => {
    const previous = [orderedList(1, ['first'])];
    const snapshot = structuredClone(previous);
    const merged = mergeMarkdownTokenSegments(previous, [orderedList(2, ['second'])]);

    expect(previous).toEqual(snapshot);
    expect(merged).not.toBe(previous);
    expect(merged).toHaveLength(1);
  });

  it('chains contiguous list fragments into one token instead of duplicating the later ones', () => {
    const merged = mergeMarkdownTokenSegments([orderedList(1, ['first'])], [orderedList(2, ['second']), orderedList(3, ['third'])]);

    expect(merged).toHaveLength(1);
    const list = merged[0] as Tokens.List;
    expect(list.ordered).toBe(true);
    expect(list.start).toBe(1);
    expect(list.items.map((item) => item.text)).toEqual(['first', 'second', 'third']);
  });

  it('keeps non-contiguous lists as separate tokens', () => {
    const previous = [orderedList(1, ['first'])];
    const next = orderedList(5, ['fifth']);
    const merged = mergeMarkdownTokenSegments(previous, [next]);

    expect(merged).toEqual([previous[0], next]);
  });
});
