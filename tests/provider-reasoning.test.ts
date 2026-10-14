import { describe, expect, it } from 'vitest';
import {
  listReasoningVariants,
  normalizeReasoningVariantId,
  reasoningSupportStatus,
  withReasoningVisibility,
  type ResolvedProvider,
} from '../src/provider/registry.js';
import type { CatalogModel } from '../src/provider/catalog.js';

function provider(npm: string, id = 'test'): ResolvedProvider {
  return { id, displayName: id, npm, apiKey: null, baseURL: undefined, options: {}, custom: false };
}

function model(overrides: Partial<CatalogModel> = {}): CatalogModel {
  return {
    id: 'test-model',
    reasoning: true,
    reasoning_options: [{ type: 'effort', values: ['none', 'minimal', 'low', 'medium', 'high'] }],
    ...overrides,
  };
}

describe('reasoning adapter table', () => {
  it('lists gateway effort variants from the catalog with OpenAI-parity options', () => {
    const variants = listReasoningVariants(provider('@ai-sdk/gateway', 'vercel'), model());
    expect(variants.map((variant) => variant.id)).toEqual(['default', 'none', 'minimal', 'low', 'medium', 'high']);
    expect(variants[3]).toEqual({
      id: 'low',
      label: 'Low',
      providerOptions: { openai: { reasoningEffort: 'low' } },
    });
  });

  it('keeps the existing adapters byte-for-byte compatible', () => {
    const openrouter = listReasoningVariants(provider('@openrouter/ai-sdk-provider', 'openrouter'), model());
    expect(openrouter.map((variant) => variant.id)).toEqual(['default', 'none', 'minimal', 'low', 'medium', 'high']);
    expect(openrouter[3]).toEqual({
      id: 'low',
      label: 'Low',
      providerOptions: { openrouter: { reasoning: { effort: 'low' } } },
    });

    const openai = listReasoningVariants(provider('@ai-sdk/openai', 'openai'), model());
    expect(openai[1]).toEqual({ id: 'none', label: 'Off', providerOptions: { openai: { reasoningEffort: 'none' } } });

    const anthropic = listReasoningVariants(provider('@ai-sdk/anthropic', 'anthropic'), model({ reasoning_options: [{ type: 'toggle' }] }));
    expect(anthropic.map((variant) => variant.id)).toEqual(['default', 'none', 'high']);
    expect(anthropic[2]).toEqual({
      id: 'high',
      label: 'On',
      providerOptions: { anthropic: { thinking: { type: 'adaptive', display: 'omitted' } } },
    });

    const google = listReasoningVariants(
      provider('@ai-sdk/google', 'google'),
      model({ reasoning_options: [{ type: 'budget_tokens', min: 1, max: 1000 }] }),
    );
    expect(google.some((variant) => variant.id.startsWith('budget-high-'))).toBe(true);

    const compatible = listReasoningVariants(provider('@ai-sdk/openai-compatible', 'custom.oai'), model());
    expect(compatible[1]).toEqual({
      id: 'none',
      label: 'Off',
      providerOptions: { custom: { reasoningEffort: 'none' } },
    });
  });

  it('returns only Default for adapters without a reasoning mapping', () => {
    expect(listReasoningVariants(provider('@ai-sdk/cohere', 'cohere'), model()).map((variant) => variant.id)).toEqual(['default']);
    expect(withReasoningVisibility(provider('@ai-sdk/cohere', 'cohere'), { openai: { reasoningEffort: 'high' } }, true)).toEqual({
      openai: { reasoningEffort: 'high' },
    });
  });

  it('leaves gateway visibility options untouched', () => {
    expect(withReasoningVisibility(provider('@ai-sdk/gateway', 'vercel'), {}, true)).toEqual({});
  });
});

describe('reasoningSupportStatus', () => {
  it('reports available when variants exist', () => {
    expect(reasoningSupportStatus(provider('@ai-sdk/gateway', 'vercel'), model())).toBe('available');
  });

  it('reports model-unsupported without reasoning metadata', () => {
    expect(reasoningSupportStatus(provider('@ai-sdk/gateway', 'vercel'), null)).toBe('model-unsupported');
    expect(reasoningSupportStatus(provider('@ai-sdk/gateway', 'vercel'), model({ reasoning: false }))).toBe('model-unsupported');
    expect(reasoningSupportStatus(provider('@ai-sdk/gateway', 'vercel'), model({ reasoning_options: [] }))).toBe('model-unsupported');
  });

  it('reports adapter-unmapped when metadata exists but the adapter has no mapping', () => {
    expect(reasoningSupportStatus(provider('@ai-sdk/cohere', 'cohere'), model())).toBe('adapter-unmapped');
  });
});

describe('normalizeReasoningVariantId', () => {
  it('maps the legacy auto id to default and passes everything else through', () => {
    expect(normalizeReasoningVariantId('auto')).toBe('default');
    expect(normalizeReasoningVariantId('default')).toBe('default');
    expect(normalizeReasoningVariantId('high')).toBe('high');
  });
});
