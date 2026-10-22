import { describe, expect, it } from 'vitest';
import { buildUsageCalendar } from '../../web/src/usage-calendar.js';
import type { UsageDay } from '../../web/src/types.js';

describe('settings usage calendar', () => {
  it('keeps local dates at midnight, aligns Monday first and leaves future days blank', () => {
    const today = new Date(2026, 9, 21, 0, 15);
    const day = { day: '2026-10-21', requests: 1 } as UsageDay;
    const cells = buildUsageCalendar([day], 7, today);
    expect(cells).toHaveLength(14);
    expect(cells.slice(0, 3)).toEqual([null, null, null]);
    expect(cells.filter((cell) => cell !== null).map((cell) => cell.key)).toEqual([
      '2026-10-15',
      '2026-10-16',
      '2026-10-17',
      '2026-10-18',
      '2026-10-19',
      '2026-10-20',
      '2026-10-21',
    ]);
    expect(cells[9]?.usage).toBe(day);
    expect(cells.slice(10)).toEqual([null, null, null, null]);
  });

  it('includes leap day and preserves a whole year without duplicate dates', () => {
    expect(
      buildUsageCalendar([], 2, new Date(2024, 2, 1))
        .filter((cell) => cell !== null)
        .map((cell) => cell.key),
    ).toEqual(['2024-02-29', '2024-03-01']);
    const cells = buildUsageCalendar([], 365, new Date(2026, 9, 21));
    const dates = cells.filter((cell) => cell !== null).map((cell) => cell.key);
    expect(cells.length % 7).toBe(0);
    expect(new Set(dates).size).toBe(365);
    expect(dates[0]).toBe('2025-10-22');
    expect(dates.at(-1)).toBe('2026-10-21');
  });
});
