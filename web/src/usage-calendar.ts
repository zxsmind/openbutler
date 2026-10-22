/**
 * The calendar's grid maths, kept free of the DOM so it can be tested directly.
 *
 * The component draws these cells; this decides which dates they are.
 */
import type { UsageDay } from './types.js';

function dateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/** Match the ledger's local calendar dates, including around midnight and DST. */
export function buildUsageCalendar(days: UsageDay[], count: number, today = new Date()) {
  const byDay = new Map(days.map((day) => [day.day, day]));
  const first = new Date(today.getFullYear(), today.getMonth(), today.getDate() - count + 1, 12);
  const offset = (first.getDay() + 6) % 7;
  const length = Math.ceil((offset + count) / 7) * 7;
  return Array.from({ length }, (_, index) => {
    if (index < offset || index >= offset + count) return null;
    const date = new Date(first.getFullYear(), first.getMonth(), first.getDate() + index - offset, 12);
    const key = dateKey(date);
    return { date, key, usage: byDay.get(key) };
  });
}
