import type { ModelChoice, RuntimeInfo } from './types.js';

/** Adapts Ranite's published model capabilities to the MindBox selector view. */
export interface ModelSelectionView {
  modelLabel: string;
  providerLabel: string;
  models: Array<{ route: ModelChoice; label: string; description: string; selected: boolean; disabled: boolean }>;
  reasoning: {
    value: string | null;
    label: string;
    description: string | null;
    options: Array<{ value: string; label: string }>;
    canSelect: boolean;
  };
  copy: {
    triggerLabel: string;
    chooseReasoning: string;
    chooseModel: string;
    back: string;
    reasoning: string;
    empty: string;
  };
}

export function modelRouteKey(runtime?: Pick<RuntimeInfo, 'providerId' | 'modelId'>) {
  return JSON.stringify([runtime?.providerId, runtime?.modelId]);
}

export function projectModelSelection(runtime: RuntimeInfo | undefined, models: ModelChoice[]): ModelSelectionView | null {
  if (!runtime?.modelId || !runtime.providerId) return null;
  const current = models.find((model) => modelRouteKey(model) === modelRouteKey(runtime));
  const options = (runtime.reasoningVariants ?? []).map(({ id, label }) => ({ value: id, label }));
  const defaultOption = options.find((option) => option.value === runtime.reasoningDefault) ?? options[0];
  const modelLabel = current?.name ?? runtime.modelId;
  const label = defaultOption?.label ?? 'Default';
  return {
    modelLabel,
    providerLabel: runtime.providerId,
    models: models.map((model) => ({
      route: model,
      label: model.name,
      description: model.providerId,
      selected: modelRouteKey(model) === modelRouteKey(runtime),
      disabled: false,
    })),
    reasoning: {
      value: defaultOption?.value ?? null,
      label,
      description: null,
      options,
      canSelect: options.length > 1,
    },
    copy: {
      triggerLabel: modelLabel,
      chooseReasoning: 'Choose reasoning effort',
      chooseModel: 'Choose model',
      back: 'Back',
      reasoning: 'Reasoning effort',
      empty: 'No models are configured.',
    },
  };
}
