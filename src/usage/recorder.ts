/**
 * Turns one model request into one ledger row.
 *
 * The row is the permanent record: what ran, where, for which session and turn,
 * how long it took, what it consumed, and what it cost. Cost prefers the
 * provider's own statement; when no provider states it, the catalog price is
 * used and the row says so, because an estimate and a bill are not the same fact.
 */
import type { ActivityLedger, UsageRow } from '../activity-ledger.js';
import { getTokenPrice } from '../provider/catalog.js';
import { resolveProviderCost } from './cost-sources.js';

export interface UsageTokens {
  inputTokens?: number;
  noCacheTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  outputTokens?: number;
  textTokens?: number;
  reasoningTokens?: number;
  totalTokens?: number;
}

export interface UsageRecordInput {
  sessionId: string;
  turnId?: string;
  eventId?: string;
  runKind: UsageRow['runKind'];
  workspaceRoot?: string;
  providerId: string;
  modelId: string;
  atMs: number;
  endedMs: number;
  attempt?: number;
  status: UsageRow['status'];
  tokens: UsageTokens;
  /** Raw provider usage, where an inline cost may sit. */
  usageRaw?: unknown;
  providerMetadata?: unknown;
  headers?: Record<string, string>;
  /** The provider's own response id, when it sends one. */
  responseId?: string;
}

/** Per-million-token prices, as the catalog states them. */
export interface TokenPrices {
  input?: number;
  output?: number;
  reasoning?: number;
  cache_read?: number;
  cache_write?: number;
}

/**
 * Catalog estimate for one request. Cache tokens are billed at their own rate and
 * are already part of the input count, so they are priced separately and removed
 * from the plain-input share.
 */
export function estimateCost(tokens: UsageTokens, prices: TokenPrices | null): number | null {
  if (!prices) return null;
  const perMillion = (count: number | undefined, price: number | undefined) =>
    typeof count === 'number' && typeof price === 'number' ? (count * price) / 1_000_000 : 0;
  const cacheRead = tokens.cacheReadTokens ?? 0;
  const cacheWrite = tokens.cacheWriteTokens ?? 0;
  const plainInput =
    tokens.noCacheTokens ?? (typeof tokens.inputTokens === 'number' ? Math.max(0, tokens.inputTokens - cacheRead - cacheWrite) : undefined);
  const total =
    perMillion(plainInput, prices.input) +
    perMillion(tokens.outputTokens, prices.output) +
    perMillion(tokens.reasoningTokens, prices.reasoning) +
    perMillion(cacheRead, prices.cache_read) +
    perMillion(cacheWrite, prices.cache_write);
  return total > 0 ? total : null;
}

function round(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

/** Writes the row. Never throws into the run: accounting must not break a turn. */
export async function recordUsage(ledger: ActivityLedger, input: UsageRecordInput, id: string): Promise<void> {
  try {
    const resolved = resolveProviderCost({
      providerId: input.providerId,
      ...(input.usageRaw === undefined ? {} : { usageRaw: input.usageRaw }),
      ...(input.providerMetadata === undefined ? {} : { providerMetadata: input.providerMetadata }),
    });
    const prices = getTokenPrice(input.providerId, input.modelId) as TokenPrices | null;
    const estimate = resolved.costUsd === null ? estimateCost(input.tokens, prices) : null;
    const row: UsageRow = {
      id,
      atMs: input.atMs,
      endedMs: input.endedMs,
      durationMs: Math.max(0, input.endedMs - input.atMs),
      tzOffsetMin: -new Date(input.atMs).getTimezoneOffset(),
      sessionId: input.sessionId,
      ...(input.turnId ? { turnId: input.turnId } : {}),
      ...(input.eventId ? { eventId: input.eventId } : {}),
      runKind: input.runKind,
      ...(input.workspaceRoot ? { workspaceRoot: input.workspaceRoot } : {}),
      providerId: input.providerId,
      modelId: input.modelId,
      attempt: input.attempt ?? 1,
      status: input.status,
      ...(input.tokens.inputTokens === undefined ? {} : { inputTokens: input.tokens.inputTokens }),
      ...(input.tokens.noCacheTokens === undefined ? {} : { noCacheTokens: input.tokens.noCacheTokens }),
      ...(input.tokens.cacheReadTokens === undefined ? {} : { cacheReadTokens: input.tokens.cacheReadTokens }),
      ...(input.tokens.cacheWriteTokens === undefined ? {} : { cacheWriteTokens: input.tokens.cacheWriteTokens }),
      ...(input.tokens.outputTokens === undefined ? {} : { outputTokens: input.tokens.outputTokens }),
      ...(input.tokens.textTokens === undefined ? {} : { textTokens: input.tokens.textTokens }),
      ...(input.tokens.reasoningTokens === undefined ? {} : { reasoningTokens: input.tokens.reasoningTokens }),
      ...(input.tokens.totalTokens === undefined ? {} : { totalTokens: input.tokens.totalTokens }),
      usageSource: input.tokens.totalTokens === undefined && input.tokens.inputTokens === undefined ? 'absent' : 'provider',
      ...(prices?.input === undefined ? {} : { priceInput: prices.input }),
      ...(prices?.output === undefined ? {} : { priceOutput: prices.output }),
      ...(prices?.reasoning === undefined ? {} : { priceReasoning: prices.reasoning }),
      ...(prices?.cache_read === undefined ? {} : { priceCacheRead: prices.cache_read }),
      ...(prices?.cache_write === undefined ? {} : { priceCacheWrite: prices.cache_write }),
      ...(resolved.costUsd === null && estimate === null ? {} : { costUsd: round(resolved.costUsd ?? estimate ?? 0) }),
      costSource: resolved.costUsd !== null ? resolved.source : estimate !== null ? 'catalog-estimate' : 'none',
      ...(input.responseId ? { generationId: input.responseId } : {}),
    };
    ledger.recordUsage(row);
  } catch {
    /* Accounting is best effort: a failed row must never fail the request. */
  }
}
