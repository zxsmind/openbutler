import { describe, expect, it } from 'vitest';
import {
  FrameSelectionTracker,
  injectFrameSelection,
  normalizeSelection,
  plainFrameLines,
  selectionCellText,
} from '../../src/cli/frame-selection.js';

describe('plainFrameLines', () => {
  it('strips color, cursor and OSC sequences while keeping the frame text', () => {
    const frame = '\u001b[2K\u001b[1A\u001b[32mhello\u001b[0m world\n\u001b[?25lsecond\u001b]52;c;abc\u0007 line';
    expect(plainFrameLines(frame)).toEqual(['hello world', 'second line']);
  });
});

describe('injectFrameSelection', () => {
  it('wraps exactly the selected cells of one row', () => {
    const frame = '\u001b[2K\u001b[1Ahello world\nsecond line\nthird';
    const injected = injectFrameSelection(frame, { start: { row: 0, col: 1 }, end: { row: 0, col: 4 } });
    expect(injected).toBe('\u001b[2K\u001b[1Ah\u001b[7mell\u001b[27mo world\nsecond line\nthird');
  });

  it('keeps inverse video across mid-selection style resets', () => {
    const injected = injectFrameSelection('A\u001b[31mBCD\u001b[0mE', { start: { row: 0, col: 0 }, end: { row: 0, col: 5 } });
    expect(injected).toBe('\u001b[7mA\u001b[31m\u001b[7mBCD\u001b[0m\u001b[7mE\u001b[27m');
  });

  it('highlights middle rows end to end', () => {
    const injected = injectFrameSelection('aa\nbb\ncc', { start: { row: 0, col: 1 }, end: { row: 2, col: 1 } });
    expect(injected).toBe('a\u001b[7ma\u001b[27m\n\u001b[7mbb\u001b[27m\n\u001b[7mc\u001b[27mc');
  });

  it('counts astral characters as one cell', () => {
    const injected = injectFrameSelection('ab\u{1F44B}cd', { start: { row: 0, col: 0 }, end: { row: 0, col: 4 } });
    expect(injected).toBe('\u001b[7mab\u{1F44B}c\u001b[27md');
  });

  it('leaves the frame untouched for collapsed or out-of-range selections', () => {
    const frame = 'line one\nline two';
    expect(injectFrameSelection(frame, { start: { row: 1, col: 3 }, end: { row: 0, col: 1 } })).toBe(frame);
    expect(injectFrameSelection('\u001b[7malready\u001b[27m', { start: { row: 0, col: 2 }, end: { row: 0, col: 2 } })).toBe(
      '\u001b[7malready\u001b[27m',
    );
  });
});

describe('selectionCellText', () => {
  it('extracts a multi-row selection and trims trailing spaces per line', () => {
    const lines = ['hello   ', 'world  ', 'tail'];
    expect(selectionCellText(lines, { start: { row: 0, col: 1 }, end: { row: 2, col: 2 } })).toBe('ello\nworld\nta');
  });

  it('clamps columns past the end of a line', () => {
    expect(selectionCellText(['ab'], { start: { row: 0, col: 0 }, end: { row: 0, col: 40 } })).toBe('ab');
  });
});

describe('normalizeSelection', () => {
  it('orders a reversed drag', () => {
    expect(normalizeSelection({ anchor: { row: 3, col: 9 }, focus: { row: 1, col: 2 } })).toEqual({
      start: { row: 1, col: 2 },
      end: { row: 3, col: 9 },
    });
    expect(normalizeSelection({ anchor: { row: 2, col: 7 }, focus: { row: 2, col: 3 } })).toEqual({
      start: { row: 2, col: 3 },
      end: { row: 2, col: 7 },
    });
  });
});

describe('FrameSelectionTracker', () => {
  it('tracks a drag, copies the selected text and drops the selection when the frame changes', () => {
    const tracker = new FrameSelectionTracker();
    const frame = 'l1\nl2\nl3';
    expect(tracker.frame(frame)).toBe(frame);

    tracker.press({ row: 0, col: 0 });
    expect(tracker.drag({ row: 1, col: 2 })).toBe(true);
    expect(tracker.isDragging).toBe(true);
    expect(tracker.frame(frame)).not.toBe(frame);
    expect(tracker.release()).toBe('selection');
    expect(tracker.text()).toBe('l1\nl2');

    const changed = tracker.frame('x1\nx2\nx3');
    expect(changed).toBe('x1\nx2\nx3');
    expect(tracker.text()).toBe('');
  });

  it('treats a press and release in one cell as a click', () => {
    const tracker = new FrameSelectionTracker();
    tracker.frame('abc\ndef');
    tracker.press({ row: 1, col: 1 });
    expect(tracker.release()).toBe('click');
    expect(tracker.selection()).toBeNull();
  });

  it('re-emits the last frame with the current highlight', () => {
    const tracker = new FrameSelectionTracker();
    tracker.frame('one\ntwo');
    expect(tracker.repaint()).toBe('one\ntwo');
    tracker.press({ row: 0, col: 0 });
    tracker.drag({ row: 0, col: 2 });
    expect(tracker.repaint()).toBe('\u001b[7mon\u001b[27me\ntwo');
    tracker.clear();
    expect(tracker.repaint()).toBe('one\ntwo');
  });
});
