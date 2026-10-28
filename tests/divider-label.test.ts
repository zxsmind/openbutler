import { describe, expect, it } from 'vitest';
import { dividerLabel } from '../src/divider-label.js';

// 2026-10-28 is a Wednesday; the ladder is pinned against that fixed "now".
const now = new Date(2026, 9, 28, 12, 5);

describe('dividerLabel', () => {
  it('reads the same local day as Today with the stored time', () => {
    expect(dividerLabel({ at: new Date(2026, 9, 28, 3, 48).getTime() }, now)).toBe('Today 03:48');
  });

  it('turns the previous day into Yesterday without a time', () => {
    expect(dividerLabel({ at: new Date(2026, 9, 27, 23, 10).getTime() }, now)).toBe('Yesterday');
  });

  it('names a weekday within the week and a date beyond it', () => {
    expect(dividerLabel({ at: new Date(2026, 9, 26, 9, 0).getTime() }, now)).toBe('Monday');
    expect(dividerLabel({ at: new Date(2026, 9, 22, 9, 0).getTime() }, now)).toBe('Thursday');
    expect(dividerLabel({ at: new Date(2026, 8, 30, 9, 0).getTime() }, now)).toBe('Sep 30');
  });

  it('passes a statement divider through untouched, whatever the clock says', () => {
    expect(dividerLabel({ text: 'Model changed from "a" to "b"', at: new Date(2026, 8, 1).getTime() }, now)).toBe(
      'Model changed from "a" to "b"',
    );
  });

  it('treats a future timestamp as today and an empty entry as empty', () => {
    expect(dividerLabel({ at: new Date(2026, 9, 28, 23, 55).getTime() }, now)).toBe('Today 23:55');
    expect(dividerLabel({}, now)).toBe('');
  });
});
