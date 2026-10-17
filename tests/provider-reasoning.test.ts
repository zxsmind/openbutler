import { describe, expect, it } from 'vitest';
import {
  listReasoningVariants,
  minimalReasoningOptions,
  normalizeReasoningVariantId,
  reasoningSupportStatus,
  resolveReasoningVariant,
  withReasoningVisibility,
  type ResolvedProvider,
  type ReasoningVariant,
} from '../src/provider/registry.js';
import type { CatalogModel } from '../src/provider/catalog.js';

function provider(npm: string, id = 'test'): ResolvedProvider {
  return { id, displayName: id, npm, apiKey: null, apiKeys: [], baseURL: undefined, options: {}, custom: false };
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

describe('resolveReasoningVariant', () => {
  const variant = (id: string): ReasoningVariant => ({ id, label: id, providerOptions: {} });
  const efforts = () => [variant('default'), variant('none'), variant('low'), variant('medium'), variant('high')];

  it('uses the stored preference when the model lists it', () => {
    expect(resolveReasoningVariant(efforts(), 'low').id).toBe('low');
  });

  it('normalizes the legacy auto id before matching', () => {
    expect(resolveReasoningVariant(efforts(), 'auto').id).toBe('default');
  });

  it('degrades a stale preference to the strongest effort the model offers', () => {
    expect(resolveReasoningVariant(efforts(), 'xhigh').id).toBe('high');
    expect(resolveReasoningVariant(efforts(), 'removed-next-month').id).toBe('high');
  });

  it('never resolves to Off: models without efforts stay on Default', () => {
    expect(resolveReasoningVariant([variant('default')], 'xhigh').id).toBe('default');
    expect(resolveReasoningVariant([variant('default'), variant('none')], 'high').id).toBe('default');
  });

  it('prefers the maximum budget variant when only budgets exist', () => {
    const budgets = [variant('default'), variant('budget-high-16000'), variant('budget-max-32000')];
    expect(resolveReasoningVariant(budgets, 'xhigh').id).toBe('budget-max-32000');
  });

  it('falls back to a Default shape for an empty list', () => {
    expect(resolveReasoningVariant([], 'high')).toEqual({ id: 'default', label: 'Default', providerOptions: {} });
  });
});

describe('minimalReasoningOptions', () => {
  const effortModel = (values: (string | null)[]) => model({ reasoning_options: [{ type: 'effort', values }] });
  const toggleModel = () => model({ reasoning_options: [{ type: 'toggle' }] });
  const budgetModel = () => model({ reasoning_options: [{ type: 'budget_tokens', min: 1, max: 1000 }] });

  it('prefers an explicit off over a minimal effort when the adapter supports a toggle', () => {
    expect(minimalReasoningOptions(provider('@ai-sdk/openai', 'openai'), toggleModel())).toEqual({
      openai: { reasoningEffort: 'none' },
    });
    expect(
      minimalReasoningOptions(
        provider('@ai-sdk/openai', 'openai'),
        model({ reasoning_options: [{ type: 'toggle' }, { type: 'effort', values: ['low', 'high'] }] }),
      ),
    ).toEqual({ openai: { reasoningEffort: 'none' } });
  });

  it('uses the catalog first effort value without ever naming it', () => {
    // openai-compatible has no toggle mapping, so the first catalog value wins.
    expect(minimalReasoningOptions(provider('@ai-sdk/openai-compatible', 'custom.oai'), effortModel(['low', 'high']))).toEqual({
      custom: { reasoningEffort: 'low' },
    });
    // An adapter-level off switch beats any effort value, even unlisted: no names involved.
    expect(minimalReasoningOptions(provider('@ai-sdk/google', 'google'), effortModel(['minimal', 'high']))).toEqual({
      google: { thinkingConfig: { thinkingBudget: 0 } },
    });
    expect(minimalReasoningOptions(provider('@ai-sdk/openai', 'openai'), budgetModel())).toEqual({
      openai: { reasoningEffort: 'none' },
    });
  });

  it('yields nothing when off is inexpressible and no effort value maps', () => {
    expect(minimalReasoningOptions(provider('@ai-sdk/openai-compatible', 'custom.oai'), budgetModel())).toBeNull();
    expect(minimalReasoningOptions(provider('@ai-sdk/openai', 'openai'), model({ reasoning: false }))).toBeNull();
    expect(minimalReasoningOptions(provider('@ai-sdk/openai', 'openai'), null)).toBeNull();
    expect(minimalReasoningOptions(provider('@ai-sdk/cohere', 'cohere'), effortModel(['low']))).toBeNull();
  });
});
