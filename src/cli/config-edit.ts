import { rememberProviderModel, saveSettings, type SettingsStore } from '../settings.js';
import { listToolCapableModels } from '../provider/registry.js';
import { isCatalogLoaded } from '../provider/catalog.js';
import { providerIsConfigured } from '../provider/registry.js';

export { defaultModelIsUsable } from '../provider/registry.js';
// Settings mutations live beside the settings they mutate; re-exported so the
// interactive command surface keeps one import site.
export { removeProvider, upsertProvider } from '../settings.js';

/**
 * Mutations for the interactive `ranite config` command.
 *
 * Every function edits the in-memory store and writes it straight back, so the
 * management surface is repeatable: nothing here depends on a wizard having run
 * first. Keep each function small and free of prompts so it stays testable.
 */

export function writeSettings(settings: SettingsStore): void {
  saveSettings(settings);
}

/** Ids of providers that are enabled and hold at least one key. */
export function readyProviderIds(settings: SettingsStore): string[] {
  return Object.entries(settings.providers)
    .filter(([id, state]) => state.enabled && providerIsConfigured(id, state))
    .map(([id]) => id);
}

export interface ProviderSummary {
  id: string;
  enabled: boolean;
  keyCount: number;
  /**
   * Models this provider can serve that can call tools, or null when it cannot
   * be counted. Null is not zero: zero means the catalog was read and nothing
   * qualifies, while null means the catalog has no entry for this provider at
   * all, so there is no list to count.
   */
  toolCapableCount: number | null;
  /** True when this provider is the one a run uses. */
  isDefault: boolean;
  /** Has credentials. Whether its model can call tools is a separate question. */
  ready: boolean;
  custom: boolean;
  url: string;
}

export function summarizeProviders(settings: SettingsStore): ProviderSummary[] {
  const loaded = isCatalogLoaded();
  return Object.entries(settings.providers).map(([id, state]) => {
    const custom = Boolean(state.npm) || Boolean(state.url);
    const toolCapableCount = loaded && !custom ? listToolCapableModels([id], { [id]: state }).length : null;
    return {
      id,
      enabled: state.enabled,
      keyCount: state.keys.length,
      toolCapableCount,
      isDefault: settings.defaultProvider === id,
      ready: state.enabled && providerIsConfigured(id, state),
      custom,
      url: state.url ?? '',
    };
  });
}

/**
 * Sets the one model a run uses.
 *
 * Also fixes the provider it belongs to, so the pair can never disagree.
 */
export function setDefaultModel(settings: SettingsStore, providerId: string, modelId: string): boolean {
  if (!(providerId in settings.providers)) return false;
  rememberProviderModel(settings, settings.defaultProvider, settings.defaultModel);
  rememberProviderModel(settings, providerId, modelId);
  settings.defaultProvider = providerId;
  settings.defaultModel = modelId;
  return true;
}

export interface ReadinessReport {
  ready: boolean;
  problems: string[];
  hints: string[];
}

/**
 * What still stands between this configuration and a working run.
 *
 * A provider with a key is not enough for ranite. The model also has to be able
 * to call a tool, or the agent has no way to look at the machine and every
 * answer is a guess.
 *
 * Sync and pure on purpose: the caller owns loading the catalog. Without it the
 * tool-capable count is unknown, and unknown is reported as a problem rather
 * than as a pass.
 */
export function readiness(settings: SettingsStore): ReadinessReport {
  const problems: string[] = [];
  const hints: string[] = [];

  const providers = readyProviderIds(settings);
  if (providers.length === 0) {
    problems.push('No LLM provider is enabled with an API key.');
    hints.push('Configure a provider and key: ranite setup');
    return { ready: false, problems, hints };
  }

  const summaries = summarizeProviders(settings);
  const usable = providers.filter((id) => (summaries.find((entry) => entry.id === id)?.toolCapableCount ?? 0) > 0);
  const customConfigured = providers.some((id) => {
    const provider = settings.providers[id];
    return Boolean(provider.npm || provider.url);
  });
  if (usable.length === 0 && !customConfigured) {
    const unknown = summaries.some((entry) => entry.toolCapableCount === null);
    if (unknown) {
      problems.push('The model catalog has not been loaded, so no model can be verified.');
      hints.push('Load it: ranite config  (needs network or a warm cache)');
    } else {
      problems.push('No enabled provider has a model that can call tools.');
      hints.push('Pick a model: ranite setup  (the catalog includes models that cannot call tools)');
    }
  }

  if (!settings.defaultProvider || !settings.defaultModel) {
    hints.push('No default model is selected, so ranite --c will not run.');
  }

  return { ready: problems.length === 0, problems, hints };
}
