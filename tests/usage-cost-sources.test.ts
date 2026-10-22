import { describe, expect, it } from 'vitest';
import { readCost, resolveProviderCost } from '../src/usage/cost-sources.js';
import { estimateCost } from '../src/usage/recorder.js';

describe('provider cost', () => {
  it('reads the cost the gateway states in the completion', () => {
    const resolved = resolveProviderCost({ providerId: 'vercel', usageRaw: { cost: 0.00001064 } });
    expect(resolved).toEqual({ costUsd: 0.00001064, source: 'provider-inline' });
  });

  it('accepts a cost stated as a decimal string', () => {
    const resolved = resolveProviderCost({
      providerId: 'vercel',
      providerMetadata: { gateway: { cost: '0.00001064' } },
    });
    expect(resolved).toEqual({ costUsd: 0.00001064, source: 'provider-inline' });
  });

  it('reads a nested usage cost when that is where it sits', () => {
    expect(readCost({ usage: { cost: 0.5 } }, [['usage', 'cost']])).toBe(0.5);
    expect(readCost({ usage: {} }, [['usage', 'cost']])).toBeNull();
    expect(readCost(null, [['usage', 'cost']])).toBeNull();
  });

  it('says nothing when the provider states no cost', () => {
    expect(resolveProviderCost({ providerId: 'anthropic', usageRaw: { inputTokens: 10 } })).toEqual({
      costUsd: null,
      source: 'none',
    });
  });
});

describe('cost estimate', () => {
  it('prices cache tokens at their own rate and keeps them out of plain input', () => {
    const cost = estimateCost({ noCacheTokens: 1_000_000, cacheReadTokens: 1_000_000, outputTokens: 0 }, { input: 3, cache_read: 0.3 });
    expect(cost).toBeCloseTo(3.3, 6);
  });

  it('derives plain input when only the total is reported', () => {
    const cost = estimateCost({ inputTokens: 2_000_000, cacheReadTokens: 1_000_000, outputTokens: 0 }, { input: 1, cache_read: 0.1 });
    expect(cost).toBeCloseTo(1.1, 6);
  });

  it('returns nothing when the model has no price', () => {
    expect(estimateCost({ inputTokens: 10, outputTokens: 10 }, null)).toBeNull();
  });
});
