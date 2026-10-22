import { describe, expect, it } from 'vitest';
import type { UsageRow } from '../src/activity-ledger.js';
import {
  bucketUsage,
  bucketUsageByHour,
  formatCost,
  formatTokens,
  localDay,
  localHour,
  sparkline,
  summarizeUsage,
} from '../src/usage/report.js';

const row = (atMs: number, overrides: Partial<UsageRow> = {}): UsageRow => ({
  id: `row-${atMs}`,
  atMs,
  tzOffsetMin: 180,
  sessionId: 'session-a',
  runKind: 'chat',
  providerId: 'vercel',
  modelId: 'model-a',
  attempt: 1,
  status: 'ok',
  usageSource: 'provider',
  ...overrides,
});

describe('usage report', () => {
  it('buckets rows by the local day the offset describes', () => {
    // 2026-10-21T22:30:00Z is 2026-10-22 01:30 in a +03:00 zone.
    const late = Date.parse('2026-10-21T22:30:00Z');
    expect(localDay({ atMs: late, tzOffsetMin: 180 })).toBe('2026-10-22');
    expect(localDay({ atMs: late, tzOffsetMin: 0 })).toBe('2026-10-21');
  });

  it('sums one day of requests into one row', () => {
    const at = Date.parse('2026-10-21T09:00:00Z');
    const days = bucketUsage([
      row(at, { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 800, costUsd: 0.002, durationMs: 1000 }),
      row(at + 1000, { inputTokens: 500, outputTokens: 50, reasoningTokens: 20, costUsd: 0.001, durationMs: 2000 }),
    ]);
    expect(days).toHaveLength(1);
    expect(days[0]).toMatchObject({
      requests: 2,
      inputTokens: 1500,
      outputTokens: 150,
      reasoningTokens: 20,
      cacheReadTokens: 800,
      durationMs: 3000,
    });
    expect(days[0]!.costUsd).toBeCloseTo(0.003, 9);
  });

  it('keeps fresh input apart from cache hits so the numbers add up', () => {
    const at = Date.parse('2026-10-21T09:00:00Z');
    const days = bucketUsage([
      // The provider's prompt count includes the cached part; fresh is the rest.
      row(at, { inputTokens: 1000, cacheReadTokens: 800, cacheWriteTokens: 100 }),
      // When the provider states the fresh part directly, it is trusted as is.
      row(at + 1, { inputTokens: 500, noCacheTokens: 400, cacheReadTokens: 100 }),
    ]);
    expect(days[0]).toMatchObject({ freshInputTokens: 500, inputTokens: 1500, cacheReadTokens: 900, cacheWriteTokens: 100 });
  });

  it('names the busiest day and counts a streak back from the newest day', () => {
    const days = bucketUsage([
      row(Date.parse('2026-10-19T09:00:00Z')),
      row(Date.parse('2026-10-20T09:00:00Z')),
      row(Date.parse('2026-10-20T10:00:00Z')),
      row(Date.parse('2026-10-21T09:00:00Z')),
    ]);
    const summary = summarizeUsage(days, [row(Date.parse('2026-10-21T09:00:00Z'), { durationMs: 7000 })]);
    expect(summary.busiest?.day).toBe('2026-10-20');
    expect(summary.streakDays).toBe(3);
    expect(summary.requests).toBe(4);
    expect(summary.longestTaskMs).toBe(7000);
  });

  it('counts priced and estimated rows separately', () => {
    const at = Date.parse('2026-10-21T09:00:00Z');
    const summary = summarizeUsage(bucketUsage([row(at), row(at + 1)]), [
      row(at, { costSource: 'provider-inline' }),
      row(at + 1, { costSource: 'catalog-estimate' }),
    ]);
    expect(summary.pricedRows).toBe(1);
    expect(summary.unpricedRows).toBe(1);
  });

  it('reads token counts and money at a glance', () => {
    expect(formatTokens(812)).toBe('812');
    expect(formatTokens(49_454)).toBe('49.5k');
    expect(formatTokens(41_536_541)).toBe('41.5M');
    expect(formatCost(0.3172)).toBe('$0.3172');
  });

  it('places a row in the local hour its offset describes', () => {
    // 2026-10-21T22:30:00Z is 2026-10-22 01:30 in a +03:00 zone.
    const late = Date.parse('2026-10-21T22:30:00Z');
    expect(localHour({ atMs: late, tzOffsetMin: 180 })).toBe('2026-10-22 01:00');
    expect(localHour({ atMs: late, tzOffsetMin: 0 })).toBe('2026-10-21 22:00');
  });

  it('splits a day into hours without changing its totals', () => {
    const at = Date.parse('2026-10-21T09:10:00Z');
    const rows = [
      row(at, { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 800, costUsd: 0.002 }),
      row(at + 5 * 60_000, { inputTokens: 200, outputTokens: 20, costUsd: 0.001 }),
      row(at + 70 * 60_000, { inputTokens: 50, outputTokens: 5, costUsd: 0.0005 }),
    ];
    const hours = bucketUsageByHour(rows);
    // Two rows fall in the same local hour, the third in the next one.
    expect(hours.map((hour) => hour.hour)).toEqual(['2026-10-21 12:00', '2026-10-21 13:00']);
    expect(hours[0]).toMatchObject({ requests: 2, inputTokens: 1200, outputTokens: 120, cacheReadTokens: 800 });
    const days = bucketUsage(rows);
    expect(hours.reduce((sum, hour) => sum + hour.costUsd, 0)).toBeCloseTo(days[0]!.costUsd, 9);
    expect(hours.reduce((sum, hour) => sum + hour.requests, 0)).toBe(days[0]!.requests);
  });

  it('draws one column per value, scaled to the peak', () => {
    expect(sparkline([0, 5, 10])).toHaveLength(3);
    expect(sparkline([10, 10])).toBe('\u2588\u2588');
    expect(sparkline([0, 0])).toBe('\u2581\u2581');
    expect(sparkline([1, 10])[1]).toBe('\u2588');
  });
});

describe('hourly grouping for the web view', () => {
  it('sums a day, finds its busiest hour and the window peak', async () => {
    const { groupHoursByDay } = await import('../src/usage/report.js');
    const hours = [
      {
        hour: '2026-10-21 09:00',
        requests: 2,
        freshInputTokens: 100,
        inputTokens: 100,
        outputTokens: 50,
        reasoningTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: 0.01,
        durationMs: 1000,
        tokens: 150,
      },
      {
        hour: '2026-10-21 14:00',
        requests: 3,
        freshInputTokens: 400,
        inputTokens: 400,
        outputTokens: 200,
        reasoningTokens: 0,
        cacheReadTokens: 100,
        cacheWriteTokens: 0,
        costUsd: 0.02,
        durationMs: 2000,
        tokens: 700,
      },
      {
        hour: '2026-10-22 10:00',
        requests: 1,
        freshInputTokens: 10,
        inputTokens: 10,
        outputTokens: 5,
        reasoningTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: 0.001,
        durationMs: 500,
        tokens: 15,
      },
    ];
    const { peak, days } = groupHoursByDay(hours);
    expect(days.map((day) => day.day)).toEqual(['2026-10-21', '2026-10-22']);
    expect(days[0]).toMatchObject({ requests: 5, tokens: 850, busiestHour: '14:00' });
    expect(days[0]?.costUsd).toBeCloseTo(0.03, 6);
    expect(days[0]?.hours.map((hour) => hour.label)).toEqual(['09:00', '14:00']);
    expect(peak).toBe(700);
  });
});
