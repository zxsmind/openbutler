/**
 * Shared relevance gating for the local search indexes (memory, sessions).
 * The absolute floor rejects unrelated rows, the relative band trims the weak tail
 * of a strong query, and the limit applies last. Below-floor noise is never
 * returned; an empty result is an honest `no_matches`.
 */
export interface RelevanceGate {
  /** Minimum score a row must reach to be returned at all. */
  floor: number;
  /** Fraction of the top score below which results are trimmed. */
  bandRatio: number;
}

export function gateByRelevance<T extends { score: number }>(scored: readonly T[], limit: number, gate: RelevanceGate): T[] {
  const aboveFloor = scored.filter((item) => item.score >= gate.floor);
  if (aboveFloor.length === 0) return [];
  aboveFloor.sort((left, right) => right.score - left.score);
  const topScore = aboveFloor[0]!.score;
  return aboveFloor.filter((item) => item.score >= topScore * gate.bandRatio).slice(0, limit);
}

/** The shared query tokenizer: lowercase words, digits, underscores, and hyphens of two or more characters. */
export function tokenizeTerms(value: string): string[] {
  return [...new Set(value.toLowerCase().match(/[\p{L}\p{N}_-]{2,}/gu) ?? [])];
}
