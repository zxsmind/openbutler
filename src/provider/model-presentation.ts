import { getModel, getProvider } from './catalog.js';
import { loadSettings, type SettingsStore } from '../settings.js';
import type { ModelPresentation } from './model-types.js';

export type { ModelCatalogRow, ModelPresentation } from './model-types.js';

/**
 * How one model is named, on every surface, by one rule: the operator's explicit
 * `modelSpecs.<id>.name`, then this provider's models.dev name, then the
 * untouched model id. The id is never split, and a name recorded under another
 * provider is never guessed - `getModel` looks the exact id up under the exact
 * provider, so `qwen/qwen3-embedding-4b` keeps its slash when nothing knows it.
 *
 * `settings` is optional so batch callers (a full catalog row) read the file once.
 */
export function resolveModelName(providerId: string, modelId: string, settings?: SettingsStore): string {
  const store = settings ?? loadSettings();
  return store.providers[providerId]?.modelSpecs?.[modelId]?.name ?? getModel(providerId, modelId)?.name ?? modelId;
}

/** Readable provider name: the catalog's display name, else the id itself. */
export function resolveProviderName(providerId: string): string {
  return getProvider(providerId)?.name ?? providerId;
}

/** The shared row shape behind `/api/models` and the runtime view's labels. */
export function modelPresentation(providerId: string, modelId: string, settings?: SettingsStore): ModelPresentation {
  return {
    providerId,
    modelId,
    name: resolveModelName(providerId, modelId, settings),
    providerName: resolveProviderName(providerId),
  };
}
