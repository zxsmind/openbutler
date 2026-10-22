import { useRef, useState } from 'react';
import type { ModelChoice, RuntimeInfo } from './types.js';
import { modelRouteKey, projectModelSelection } from './model-selection.js';

/** Only the unsent turn's effort is local; model changes use the existing server command. */
export function useModelSelection(
  runtime: RuntimeInfo | undefined,
  models: ModelChoice[],
  onModel: (model: ModelChoice) => Promise<boolean>,
) {
  const [open, setOpen] = useState(false);
  const [selection, setSelection] = useState<{ route: string; value: string | null } | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const retryModel = useRef<ModelChoice | null>(null);
  const route = modelRouteKey(runtime);
  const projection = projectModelSelection(runtime, models, selection?.route === route ? selection.value : null);
  async function selectModel(model: Pick<ModelChoice, 'providerId' | 'modelId'>) {
    if (inFlight.current) return false;
    const choice = models.find((item) => modelRouteKey(item) === modelRouteKey(model));
    if (!choice) return false;
    inFlight.current = true;
    retryModel.current = choice;
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
    onSelectReasoning: async (value: string | null) => {
      if (inFlight.current || (value !== null && !projection?.reasoning.options.some((option) => option.value === value))) return false;
      setSelection({ route, value });
      return true;
    },
    onRetry: () => {
      if (retryModel.current) void selectModel(retryModel.current);
    },
    reasoningVariantId: projection?.reasoning.value ?? undefined,
  };
}
