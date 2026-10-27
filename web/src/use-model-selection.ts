import { useRef, useState } from 'react';
import type { ModelChoice, RuntimeInfo } from './types.js';
import { projectModelSelection } from './model-selection.js';

/**
 * The selector edits two runtime facts through their server commands: the model
 * and the effort. Neither lives in component state, so what the menu shows is
 * always the runtime the next model request will actually use.
 */
export function useModelSelection(
  runtime: RuntimeInfo | undefined,
  models: ModelChoice[],
  onModel: (model: ModelChoice) => Promise<boolean>,
  onReasoning: (value: string) => Promise<boolean>,
) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const retryModel = useRef<ModelChoice | null>(null);
  const retryReasoning = useRef<string | null>(null);
  const projection = projectModelSelection(runtime, models);
  async function selectModel(model: Pick<ModelChoice, 'providerId' | 'modelId'>) {
    if (inFlight.current) return false;
    const choice = models.find((item) => modelRouteKeyEquals(item, model));
    if (!choice) return false;
    inFlight.current = true;
    retryModel.current = choice;
    retryReasoning.current = null;
    setPending(true);
    setError(null);
    try {
      if (!(await onModel(choice))) throw new Error('The model could not be changed. Try again.');
      retryModel.current = null;
      return true;
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }
  async function selectReasoning(value: string) {
    if (inFlight.current || !projection?.reasoning.options.some((option) => option.value === value)) return false;
    inFlight.current = true;
    retryReasoning.current = value;
    retryModel.current = null;
    setPending(true);
    setError(null);
    try {
      if (!(await onReasoning(value))) throw new Error('The effort could not be changed. Try again.');
      retryReasoning.current = null;
      return true;
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }
  return {
    projection,
    pending,
    error,
    open,
    onOpenChange: setOpen,
    // Model snapshots may arrive before their command is acknowledged. Keep the
    // pending surface mounted; the selector owns its navigation/exit animation.
    resetKey: undefined,
    onSelectModel: selectModel,
    onSelectReasoning: selectReasoning,
    onRetry: () => {
      if (retryModel.current) void selectModel(retryModel.current);
      else if (retryReasoning.current !== null) void selectReasoning(retryReasoning.current);
    },
    reasoningVariantId: projection?.reasoning.value ?? undefined,
  };
}

function modelRouteKeyEquals(model: Pick<ModelChoice, 'providerId' | 'modelId'>, other: Pick<ModelChoice, 'providerId' | 'modelId'>) {
  return model.providerId === other.providerId && model.modelId === other.modelId;
}
