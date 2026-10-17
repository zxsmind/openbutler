import { describe, expect, it } from 'vitest';
import { mergeProviderOptions, routingProviderOptions, type ResolvedProvider } from '../src/provider/registry.js';

function provider(npm: string, id = 'test'): ResolvedProvider {
  return { id, displayName: id, npm, apiKey: null, apiKeys: [], baseURL: undefined, options: {}, custom: false };
}

describe('routing adapter table', () => {
  it('wraps OpenRouter routing fields in the `provider` object', () => {
    const routing = { order: ['novita', 'xiaomi'], allow_fallbacks: false };
    expect(routingProviderOptions(provider('@openrouter/ai-sdk-provider', 'openrouter'), routing)).toEqual({
      openrouter: { provider: routing },
    });
  });

  it('passes Vercel gateway routing fields flat under `gateway`', () => {
    const routing = { order: ['novita'], sort: 'cost' };
    expect(routingProviderOptions(provider('@ai-sdk/gateway', 'vercel'), routing)).toEqual({
      gateway: routing,
    });
  });

  it('uses the OpenRouter shape for a custom openai-compatible gateway', () => {
    const routing = { only: ['xiaomi'] };
    expect(routingProviderOptions(provider('@ai-sdk/openai-compatible', 'my-gateway'), routing)).toEqual({
      'my-gateway': { provider: routing },
    });
  });

  it('is empty when nothing is configured or the package is not a gateway', () => {
    expect(routingProviderOptions(provider('@openrouter/ai-sdk-provider', 'openrouter'), undefined)).toEqual({});
    expect(routingProviderOptions(provider('@openrouter/ai-sdk-provider', 'openrouter'), {})).toEqual({});
    expect(routingProviderOptions(provider('@ai-sdk/anthropic', 'anthropic'), { order: ['x'] })).toEqual({});
  });
});

describe('mergeProviderOptions', () => {
  it('returns the base unchanged when there is nothing to merge', () => {
    const base = { openrouter: { reasoning: { effort: 'low' } } };
    expect(mergeProviderOptions(base, {})).toBe(base);
  });

  it('combines a namespace both fragments use', () => {
    const merged = mergeProviderOptions(
      { openrouter: { reasoning: { effort: 'low' } } },
      { openrouter: { provider: { order: ['novita'] } } },
    );
    expect(merged).toEqual({ openrouter: { reasoning: { effort: 'low' }, provider: { order: ['novita'] } } });
  });

  it('keeps distinct namespaces apart', () => {
    const merged = mergeProviderOptions({ openai: { reasoningEffort: 'high' } }, { gateway: { order: ['novita'] } });
    expect(merged).toEqual({ openai: { reasoningEffort: 'high' }, gateway: { order: ['novita'] } });
  });
});
