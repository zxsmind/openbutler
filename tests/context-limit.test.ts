import { describe, expect, it } from 'vitest';
import { effectiveContextWindowTokens } from '../src/session-store.js';

describe('effectiveContextWindowTokens', () => {
  it('keeps the model window for sessions without a cap', () => {
    expect(effectiveContextWindowTokens(1_048_576, undefined, undefined)).toBe(1_048_576);
    expect(effectiveContextWindowTokens(1_048_576, undefined, 900_000)).toBe(1_048_576);
  });

  it('applies the stamped cap while measured context is under it', () => {
    expect(effectiveContextWindowTokens(1_048_576, 200_000, undefined)).toBe(200_000);
    expect(effectiveContextWindowTokens(1_048_576, 200_000, 150_000)).toBe(200_000);
  });

  it('returns the full window once measured context has passed the cap', () => {
    // Compaction cannot summarise down through a limit its own request would
    // already exceed, so an oversized chat keeps normal behaviour instead of
    // failing at every step boundary.
    expect(effectiveContextWindowTokens(1_048_576, 200_000, 240_000)).toBe(1_048_576);
    expect(effectiveContextWindowTokens(1_048_576, 200_000, 200_000)).toBe(1_048_576);
  });

  it('never invents a window when the model has none', () => {
    expect(effectiveContextWindowTokens(null, 200_000, undefined)).toBeNull();
    expect(effectiveContextWindowTokens(null, undefined, 100_000)).toBeNull();
  });

  it('never lets the cap exceed the model window', () => {
    expect(effectiveContextWindowTokens(128_000, 200_000, undefined)).toBe(128_000);
    expect(effectiveContextWindowTokens(128_000, 200_000, 90_000)).toBe(128_000);
  });
});
