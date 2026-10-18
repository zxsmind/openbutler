import { describe, expect, it } from 'vitest';
import { sliceTextRows } from '../../src/cli/terminal-session.js';

describe('sliceTextRows', () => {
  it('hands over only the rows in the window, with the rest reported as spacer rows', () => {
    const text = Array.from({ length: 300 }, (_, index) => `line ${index}`).join('\n');
    const sliced = sliceTextRows(text, 40, { top: 120, bottom: 160 });
    expect(sliced.text.split('\n')).toHaveLength(40);
    expect(sliced.headRows).toBe(120);
    expect(sliced.tailRows).toBe(140);
    expect(sliced.text.startsWith('line 120\n')).toBe(true);
  });

  it('maps a wrapped line to the rows it actually occupies', () => {
    const text = Array.from({ length: 20 }, () => 'x'.repeat(100)).join('\n');
    const sliced = sliceTextRows(text, 50, { top: 8, bottom: 16 });
    // Every line is two rows wide at this width, so rows 8..16 are lines 4..7.
    expect(sliced.headRows).toBe(8);
    expect(sliced.text.split('\n')).toHaveLength(4);
    expect(sliced.tailRows).toBe(24);
  });
});
