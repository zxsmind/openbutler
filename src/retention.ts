const DURATION_UNITS: Record<string, number> = {
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

/** Parses an explicit retention window such as `30d`, `12h`, `90m`, or `2w`. */
export function parseRetentionDuration(text: string): number {
  const match = /^(\d+)([mhdw])$/.exec(text.trim().toLowerCase());
  const value = match ? Number(match[1]) : Number.NaN;
  if (!match || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Invalid duration "${text}". Use a value like 30d, 12h, 90m, or 2w.`);
  }
  return value * DURATION_UNITS[match[2]!]!;
}

export interface RetainedFile {
  modifiedAt: number;
}

/** Files last modified before the cutoff; pruning always keeps anything newer. */
export function selectFilesToPrune<T extends RetainedFile>(files: readonly T[], cutoffMs: number): T[] {
  return files.filter((file) => file.modifiedAt < cutoffMs);
}
