import { describe, expect, it } from 'vitest';
import { diffStat } from '../src/file-write-core.js';

describe('diffStat', () => {
  it('reports no change for identical text', () => {
    expect(diffStat('a\nb\n', 'a\nb\n')).toEqual({ addedLines: 0, removedLines: 0 });
  });

  it('counts a single changed line', () => {
    expect(diffStat('one\ntwo\nthree\n', 'one\nTWO\nthree\n')).toEqual({ addedLines: 1, removedLines: 1 });
  });

  it('counts insertions and deletions at the edges', () => {
    expect(diffStat('b\n', 'a\nb\n')).toEqual({ addedLines: 1, removedLines: 0 });
    expect(diffStat('a\nb\n', 'b\n')).toEqual({ addedLines: 0, removedLines: 1 });
  });

  it('counts distant changes on both sides', () => {
    const oldText = ['l0', 'l1', 'l2', 'l3', 'l4', 'l5', 'l6', 'l7', 'l8', 'l9', 'l10', 'l11', 'l12'].join('\n');
    const newText = ['L0', 'l1', 'l2', 'l3', 'l4', 'l5', 'l6', 'l7', 'l8', 'l9', 'l10', 'l11', 'L12'].join('\n');
    expect(diffStat(oldText, newText)).toEqual({ addedLines: 2, removedLines: 2 });
  });

  it('counts a full rewrite on both sides', () => {
    const oldText = Array.from({ length: 200 }, (_, index) => `old-${index}`).join('\n');
    const newText = Array.from({ length: 200 }, (_, index) => `new-${index}`).join('\n');
    expect(diffStat(oldText, newText)).toEqual({ addedLines: 200, removedLines: 200 });
  });

  it('refuses inputs that are too large to diff safely', () => {
    const big = Array.from({ length: 5000 }, () => 'x').join('\n');
    expect(diffStat(big, 'y')).toBeNull();
    expect(diffStat('y', big)).toBeNull();
  });
});
