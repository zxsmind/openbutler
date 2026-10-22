/**
 * Where a request's real cost comes from: the provider's own answer.
 *
 * Gateways state the bill inside the completion (`usage.cost`, and the gateway
 * block repeats it), so the cost is read from the response the model call already
 * returned. No second request, no polling, no id to chase.
 *
 * A provider that says nothing gets a catalog estimate, labelled as one: an
 * estimate and a bill are different facts and must not be mixed.
 */

export type CostSourceKind = 'provider-inline' | 'catalog-estimate' | 'none';

/**
 * Where a provider may state a request's cost. One list for every provider: the
 * shapes below cover the gateways in use (Vercel states usage.cost and repeats it
 * as gateway.cost, OpenRouter states usage.cost), and a provider that names it
 * something else adds a path here rather than a branch anywhere.
 */
const COST_PATHS: readonly string[][] = [['usage', 'cost'], ['cost'], ['market_cost'], ['gateway', 'cost']];

/** A cost stated as a decimal string counts the same as a number. */
export function readCost(value: unknown, paths: readonly string[][]): number | null {
  for (const path of paths) {
    let current: unknown = value;
    for (const key of path) {
      if (!current || typeof current !== 'object') {
        current = undefined;
        break;
      }
      current = (current as Record<string, unknown>)[key];
    }
    if (typeof current === 'number' && Number.isFinite(current)) return current;
    if (typeof current === 'string' && current.trim()) {
      const parsed = Number(current);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

export interface CostLookupContext {
  providerId: string;
  /** Raw usage object the SDK exposes for the step. */
  usageRaw?: unknown;
  /** Per-step provider metadata, where gateways park their own fields. */
  providerMetadata?: unknown;
}

export interface ResolvedCost {
  costUsd: number | null;
  source: CostSourceKind;
}

/** The provider's stated cost for this request, or null when it states none. */
export function resolveProviderCost(context: CostLookupContext): ResolvedCost {
  for (const candidate of [context.usageRaw, context.providerMetadata]) {
    const cost = readCost(candidate, COST_PATHS);
    if (cost !== null) return { costUsd: cost, source: 'provider-inline' };
  }
  return { costUsd: null, source: 'none' };
}
