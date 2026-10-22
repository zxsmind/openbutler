/**
 * Turns recorded usage rows into the numbers a person reads: per-day totals, one
 * summary, and a sparkline that makes a month visible at a glance.
 *
 * Everything here is a pure function over rows already read from the ledger, so
 * the same code serves the CLI today and a web view later.
 */
import type { UsageRow } from '../activity-ledger.js';

export interface UsageTotals {
  requests: number;
  /** Input the provider had to read fresh; excludes cache hits and writes. */
  freshInputTokens: number;
  /** Total prompt tokens, cache included, as the provider reported them. */
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  durationMs: number;
  /** Tokens actually moved: fresh input, cache reads and output. The one number a reader needs. */
  tokens: number;
}

export interface UsageDay extends UsageTotals {
  /** Local calendar day, YYYY-MM-DD. */
  day: string;
}

export interface UsageHour extends UsageTotals {
  /** Local hour, YYYY-MM-DD HH:00. */
  hour: string;
}

/** One hour as the hourly view draws it: already summed, already formatted for meaning. */
export interface UsageHourPoint {
  hour: string;
  label: string;
  requests: number;
  tokens: number;
  costUsd: number;
}

/** A day of hours with its own totals, so the reader never has to add anything up. */
export interface UsageHourDay {
  day: string;
  requests: number;
  tokens: number;
  costUsd: number;
  /** The hour with the most tokens, as HH:00, or null for a silent day. */
  busiestHour: string | null;
  hours: UsageHourPoint[];
}

/** Tokens the provider actually moved: fresh input, cache reads and output. */
export function hourTokens(hour: UsageTotals): number {
  return hour.freshInputTokens + hour.cacheReadTokens + hour.outputTokens;
}

/**
 * Groups hourly buckets into days with their totals and the window's peak.
 *
 * The web view is a projector: it must not sum rows or decide what a bar means,
 * or two views of the same data drift apart.
 */
export function groupHoursByDay(hours: readonly UsageHour[]): { peak: number; days: UsageHourDay[] } {
  const byDay = new Map<string, UsageHourDay>();
  let peak = 0;
  for (const hour of hours) {
    const day = hour.hour.slice(0, 10);
    const entry = byDay.get(day) ?? { day, requests: 0, tokens: 0, costUsd: 0, busiestHour: null, hours: [] };
    const tokens = hour.tokens;
    entry.requests += hour.requests;
    entry.tokens += tokens;
    entry.costUsd += hour.costUsd;
    entry.hours.push({
      hour: hour.hour,
      label: hour.hour.slice(11, 16),
      requests: hour.requests,
      tokens,
      costUsd: hour.costUsd,
    });
    const busiestTokens = entry.busiestHour ? (entry.hours.find((point) => point.label === entry.busiestHour)?.tokens ?? 0) : -1;
    if (tokens > busiestTokens) entry.busiestHour = hour.hour.slice(11, 16);
    if (tokens > peak) peak = tokens;
    byDay.set(day, entry);
  }
  return { peak, days: [...byDay.values()].sort((left, right) => left.day.localeCompare(right.day)) };
}

/** The local day a row belongs to, using the offset recorded with the row. */
export function localDay(row: Pick<UsageRow, 'atMs' | 'tzOffsetMin'>): string {
  const shifted = new Date(row.atMs + row.tzOffsetMin * 60_000);
  const month = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const day = String(shifted.getUTCDate()).padStart(2, '0');
  return `${shifted.getUTCFullYear()}-${month}-${day}`;
}

/** The local hour a row belongs to, using the offset recorded with the row. */
export function localHour(row: Pick<UsageRow, 'atMs' | 'tzOffsetMin'>): string {
  const shifted = new Date(row.atMs + row.tzOffsetMin * 60_000);
  const hour = String(shifted.getUTCHours()).padStart(2, '0');
  return `${localDay(row)} ${hour}:00`;
}

function emptyTotals(): UsageTotals {
  return {
    requests: 0,
    freshInputTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0,
    durationMs: 0,
    tokens: 0,
  };
}

function addRow(bucket: UsageTotals, row: UsageRow): void {
  // The prompt count already includes cache hits and writes, so the fresh part
  // is what is left; showing both without this split double counts.
  const cacheRead = row.cacheReadTokens ?? 0;
  const cacheWrite = row.cacheWriteTokens ?? 0;
  bucket.requests += 1;
  bucket.freshInputTokens += row.noCacheTokens ?? Math.max(0, (row.inputTokens ?? 0) - cacheRead - cacheWrite);
  bucket.inputTokens += row.inputTokens ?? 0;
  bucket.outputTokens += row.outputTokens ?? 0;
  bucket.reasoningTokens += row.reasoningTokens ?? 0;
  bucket.cacheReadTokens += cacheRead;
  bucket.cacheWriteTokens += cacheWrite;
  bucket.costUsd += row.costUsd ?? 0;
  bucket.durationMs += row.durationMs ?? 0;
  // Derived last so the three parts can never disagree with the total.
  bucket.tokens = bucket.freshInputTokens + bucket.cacheReadTokens + bucket.outputTokens;
}

function groupBy(rows: readonly UsageRow[], keyOf: (row: UsageRow) => string): Map<string, UsageTotals> {
  const groups = new Map<string, UsageTotals>();
  for (const row of rows) {
    const key = keyOf(row);
    const bucket = groups.get(key) ?? emptyTotals();
    addRow(bucket, row);
    groups.set(key, bucket);
  }
  return groups;
}

export function bucketUsage(rows: readonly UsageRow[]): UsageDay[] {
  return [...groupBy(rows, localDay)].sort(([left], [right]) => left.localeCompare(right)).map(([day, totals]) => ({ day, ...totals }));
}

/** Same totals as a day, one row per local hour, for the shape of a working day. */
export function bucketUsageByHour(rows: readonly UsageRow[]): UsageHour[] {
  return [...groupBy(rows, localHour)].sort(([left], [right]) => left.localeCompare(right)).map(([hour, totals]) => ({ hour, ...totals }));
}

export interface UsageSummary {
  days: number;
  requests: number;
  freshInputTokens: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  busiest: UsageDay | null;
  longestTaskMs: number;
  /** Consecutive days ending at the newest day that recorded any request. */
  streakDays: number;
  /** How many days the provider stated the cost for, out of all rows. */
  pricedRows: number;
  unpricedRows: number;
}

export function summarizeUsage(days: readonly UsageDay[], rows: readonly UsageRow[] = []): UsageSummary {
  const summary: UsageSummary = {
    days: days.length,
    requests: 0,
    freshInputTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0,
    busiest: null,
    longestTaskMs: 0,
    streakDays: 0,
    pricedRows: 0,
    unpricedRows: 0,
  };
  for (const day of days) {
    summary.requests += day.requests;
    summary.freshInputTokens += day.freshInputTokens;
    summary.inputTokens += day.inputTokens;
    summary.outputTokens += day.outputTokens;
    summary.reasoningTokens += day.reasoningTokens;
    summary.cacheReadTokens += day.cacheReadTokens;
    summary.cacheWriteTokens += day.cacheWriteTokens;
    summary.costUsd += day.costUsd;
    if (!summary.busiest || day.requests > summary.busiest.requests) summary.busiest = day;
  }
  for (const row of rows) {
    summary.longestTaskMs = Math.max(summary.longestTaskMs, row.durationMs ?? 0);
    if (row.costSource === 'provider-inline' || row.costSource === 'provider-lookup') summary.pricedRows += 1;
    else summary.unpricedRows += 1;
  }
  // A streak counts back from the newest recorded day without a gap.
  const recorded = new Set(days.filter((day) => day.requests > 0).map((day) => day.day));
  const newest = days.at(-1)?.day;
  if (newest) {
    const cursor = new Date(`${newest}T00:00:00Z`);
    while (recorded.has(cursor.toISOString().slice(0, 10))) {
      summary.streakDays += 1;
      cursor.setUTCDate(cursor.getUTCDate() - 1);
    }
  }
  return summary;
}

/** 41.5M, 49.5k, 812: a token count a person can read at a glance. */
export function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(Math.round(value));
}

export function formatCost(value: number): string {
  return `$${value.toFixed(4)}`;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(0)}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

const SPARK = ['\u2581', '\u2582', '\u2583', '\u2584', '\u2585', '\u2586', '\u2587', '\u2588'];

/** One column per value, scaled to the largest, so a month reads as a shape. */
export function sparkline(values: readonly number[]): string {
  const peak = Math.max(0, ...values);
  if (peak === 0) return SPARK[0]!.repeat(values.length);
  return values.map((value) => SPARK[Math.min(SPARK.length - 1, Math.floor((value / peak) * (SPARK.length - 1)))]!).join('');
}

export function renderUsageReport(days: readonly UsageDay[], summary: UsageSummary, label: string): string {
  if (days.length === 0) return `No usage recorded ${label}.`;
  const width = Math.max(...days.map((day) => day.day.length));
  const lines = [
    `Usage ${label}`,
    `  requests ${summary.requests}  input ${formatTokens(summary.freshInputTokens)}  cache read ${formatTokens(summary.cacheReadTokens)}` +
      `  cache write ${formatTokens(summary.cacheWriteTokens)}  output ${formatTokens(summary.outputTokens)}` +
      `  reasoning ${formatTokens(summary.reasoningTokens)}  cost ${formatCost(summary.costUsd)}`,
    summary.busiest
      ? `  busiest ${summary.busiest.day} (${summary.busiest.requests} requests)  longest task ${formatDuration(summary.longestTaskMs)}` +
        `  streak ${summary.streakDays}d`
      : '',
    summary.unpricedRows > 0
      ? `  cost source: provider ${summary.pricedRows}, catalog estimate ${summary.unpricedRows}`
      : `  cost source: provider for every request`,
    '',
  ].filter(Boolean);
  const header = `${'day'.padEnd(width)}  reqs  ${'input'.padStart(7)}  ${'cache'.padStart(7)}  ${'output'.padStart(7)}  ${'cost'.padStart(9)}`;
  lines.push(header);
  for (const day of days) {
    lines.push(
      `${day.day.padEnd(width)}  ${String(day.requests).padStart(4)}  ${formatTokens(day.freshInputTokens).padStart(7)}  ` +
        `${formatTokens(day.cacheReadTokens).padStart(7)}  ${formatTokens(day.outputTokens).padStart(7)}  ` +
        `${formatCost(day.costUsd).padStart(9)}`,
    );
  }
  lines.push('', `token shape  ${sparkline(days.map((day) => day.freshInputTokens + day.cacheReadTokens + day.outputTokens))}`);
  return lines.join('\n');
}
