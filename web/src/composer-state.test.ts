import { describe, expect, it } from 'vitest';
import { moveHistory, readDrafts, saveDraft } from './composer-state.js';

function storage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    key: (index) => [...values.keys()][index] ?? null,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
    removeItem: (key) => {
      values.delete(key);
    },
    clear: () => values.clear(),
  };
}

describe('composer drafts', () => {
  it('restores multiline drafts independently and removes a cleared or sent draft', () => {
    const store = storage();
    store.setItem('unrelated', 'leave this alone');
    saveDraft(store, 'one', 'hello\nworld');
    saveDraft(store, 'two', 'another draft');
    expect(readDrafts(store)).toEqual({ one: 'hello\nworld', two: 'another draft' });
    saveDraft(store, 'one', '');
    expect(readDrafts(store)).toEqual({ two: 'another draft' });
    expect(store.getItem('unrelated')).toBe('leave this alone');
  });

  it('keeps storage failures from interrupting typing', () => {
    const store = storage();
    store.setItem = () => {
      throw new Error('quota');
    };
    expect(() => saveDraft(store, 'one', 'draft')).not.toThrow();
    expect(() => saveDraft(store, '', 'draft')).not.toThrow();
  });
});

describe('composer history', () => {
  it('walks backward and forward, preserving the unfinished draft', () => {
    const messages = ['first', 'second\nline'];
    const last = moveHistory(null, messages, 'unfinished\ndraft', -1)!;
    expect(last.messages[last.index]).toBe('second\nline');
    const first = moveHistory(last, messages, '', -1)!;
    expect(first.messages[first.index]).toBe('first');
    expect(moveHistory(first, messages, '', -1)?.index).toBe(0);
    const newer = moveHistory(first, messages, '', 1)!;
    const draft = moveHistory(newer, messages, '', 1)!;
    expect(draft.index).toBe(messages.length);
    expect(draft.draft).toBe('unfinished\ndraft');
  });

  it('does not let stream or queue changes shift an active history traversal', () => {
    const last = moveHistory(null, ['first', 'second'], 'draft', -1)!;
    const newer = moveHistory(last, ['older', 'first', 'second', 'queued'], '', 1)!;
    expect(newer.index).toBe(2);
    expect(newer.messages).toEqual(['first', 'second']);
    expect(newer.draft).toBe('draft');
  });

  it('leaves arrow-down and empty history to normal cursor movement', () => {
    expect(moveHistory(null, ['first'], 'draft', 1)).toBeNull();
    expect(moveHistory(null, [], 'draft', -1)).toBeNull();
  });
});
