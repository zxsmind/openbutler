import type { JSONValue, LanguageModel } from 'ai';
import { getModel, getProvider, isCatalogLoaded, listProviderIdsForModel, type CatalogModel } from './catalog.js';
import { importProviderFactory, packageReadsOwnEnv } from './install.js';
import { hasCredential, type ProviderState, type SettingsStore } from '../settings.js';

/**
 * The provider system. There is deliberately no provider name in this file.
 *
 * Providers come from the catalog: each entry carries its display name, API
 * endpoint, key environment variables, runtime npm package, and model list.
 * Settings only overlay onto catalog ids — name, keys, a baseURL override, and
 * a model whitelist. Adding a provider means setting its key; nothing here
 * changes.
 *
 * A catalog-unknown id is still usable when settings declare its runtime
 * (npm, endpoint, model), exactly like a custom provider entry. That is how a
 * local Ollama or LM Studio endpoint works without a line of code.
 *
 * Trimmed from athena's version: key rotation, `inline` tool-call mode, and
 * the router's ordering rules are gone. Two of those are deliberate and will
 * not come back in this form:
 *
 * - Key rotation needs a server that outlives a request. A CLI run has one key.
 * - `inline` tool-call mode means parsing a tool call out of the model's free
 *   text. Ranite's one non-negotiable is that the runtime, not the model,
 *   decides what executes. Reading instructions out of prose is the opposite of
 *   that, so a model that cannot call tools natively is a model ranite refuses.
 */

export interface ProviderOverride {
  /** Display name, when the user wants something other than the catalog's. */
  name?: string;
  /** Base URL, for a self-hosted endpoint or a proxy. */
  url?: string;
  /** Runtime package for a catalog-unknown id. */
  npm?: string;
  /** Explicit key list, in preference order. */
  keys?: string[];
  /**
   * Raw options handed to the runtime package, applied last.
   *
   * This is the escape hatch for anything the catalog and the environment do not
   * cover: a region, a project id, extra headers. Ranite does not interpret it,
   * so a package gains an option without Ranite gaining a line of code.
   */
  options?: Record<string, unknown>;
}

export interface ApiKeySource {
  key: string;
  /** Where the key came from. */
  source: 'settings' | 'env';
  envName?: string;
}

export interface ResolvedProvider {
  /** Catalog id (`openai`, `anthropic`, …) or a custom id. */
  id: string;
  displayName: string;
  /** AI SDK package that speaks this provider. Always from data, never code. */
  npm: string;
  /**
   * The API key to hand the runtime package, when there is one.
   *
   * Null is not a failure: some providers authenticate with a credential chain
   * or a service account instead of a single key, and their package reads those
   * variables itself. See `resolveProvider`.
   */
  apiKey: ApiKeySource | null;
  baseURL: string | undefined;
  /** Raw options for the runtime package, applied after everything else. */
  options: Record<string, unknown>;
  custom: boolean;
}

export interface UnavailableProvider {
  id: string;
  reason: string;
}

export type ProviderResolution = { ok: true; provider: ResolvedProvider } | { ok: false; error: UnavailableProvider };

function firstNonEmptyEnv(names: readonly string[] | undefined): ApiKeySource | null {
  if (!names) return null;
  for (const name of names) {
    const value = process.env[name];
    if (value && value.trim().length > 0) return { key: value, source: 'env', envName: name };
  }
  return null;
}

/**
 * Merges one provider id from the catalog and the settings overlay.
 *
 * A provider is usable when *something* authenticates it: a key in settings, a
 * key-shaped environment variable the catalog names, Ranite's generic key, or
 * options the operator wrote. The last case is how a provider that signs
 * requests with a credential chain (AWS SigV4) or a service account (Google
 * Vertex) works with no key at all — its package reads `AWS_*` and
 * `GOOGLE_*` itself, and Ranite must not stand in its way.
 */
export function resolveProvider(providerId: string, override?: ProviderOverride): ProviderResolution {
  const catalog = getProvider(providerId);
  const npm = override?.npm ?? catalog?.npm;
  if (!npm) {
    return {
      ok: false,
      error: {
        id: providerId,
        reason:
          `provider "${providerId}" is not in the model catalog and settings declare no runtime package (npm) for it. ` +
          `Set RANITE_NPM to the AI SDK package that speaks it.`,
      },
    };
  }
  const configuredKey = (override?.keys ?? []).find((key) => key.length > 0);
  /* The catalog's `env` list is the candidate key, in its own preference order.
     Whether the value is actually handed to the package is decided later, by
     `packageReadsOwnEnv`: a package that finds its own credential must not
     receive one, because a catalog list mixes secrets with names and regions
     (`AWS_ACCESS_KEY_ID` beside `AWS_BEARER_TOKEN_BEDROCK`), and passing the
     wrong one as `apiKey` would authenticate with it. */
  const apiKey = configuredKey
    ? { key: configuredKey, source: 'settings' as const }
    : (firstNonEmptyEnv(catalog?.env) ??
      firstNonEmptyEnv(['RANITE_API_KEY']) ??
      firstNonEmptyEnv(override?.npm ? ['OPENAI_API_KEY'] : undefined));

  const options = override?.options ?? {};
  /* No key and no operator-declared options means nothing can authenticate it. */
  if (!apiKey && Object.keys(options).length === 0) {
    const names = catalog?.env ?? [];
    return {
      ok: false,
      error: {
        id: providerId,
        reason:
          `provider "${providerId}" has no credential: add one in settings, ` +
          `set ${names.join(' / ') || 'RANITE_API_KEY'} in the environment, ` +
          `or declare its credentials under providers.${providerId}.options`,
      },
    };
  }

  return {
    ok: true,
    provider: {
      id: providerId,
      displayName: override?.name ?? catalog?.name ?? providerId,
      npm,
      apiKey: apiKey ?? null,
      options,
      baseURL: override?.url ?? catalog?.api ?? undefined,
      custom: !catalog,
    },
  };
}

/**
 * Whether Ranite hands this key to the runtime package, rather than leaving the
 * package to read its own environment.
 *
 * A key from settings or from Ranite's own variable is an explicit choice, so it
 * is always passed. A key found under a catalog-declared variable name is not:
 * that list mixes secrets with resource names, regions, and file paths, and the
 * package is the only thing that knows which of its variables is a credential.
 * So the package decides — unless it cannot be inspected (not installed yet, or
 * unreadable), where passing the key is the behaviour Ranite has always had, and
 * the safe default to fall back to.
 */
export function passesKeyToPackage(npm: string, key: ApiKeySource): boolean {
  if (key.source === 'settings') return true;
  if (key.envName === 'RANITE_API_KEY') return true;
  return !packageReadsOwnEnv(npm);
}

/**
 * The credential half of a runtime package's options.
 *
 * Empty when the provider authenticates another way, so the package falls back
 * to its own environment reading instead of receiving `undefined` as a key.
 */
function providerAuth(resolved: ResolvedProvider): Record<string, unknown> {
  return resolved.apiKey ? { apiKey: resolved.apiKey.key } : {};
}

interface PackageFactory {
  createModel: (resolved: ResolvedProvider, modelId: string, fetch?: typeof globalThis.fetch) => Promise<LanguageModel>;
  supportsImageToolResult?: (modelId: string) => boolean;
}

/**
 * The only place that knows how to construct an AI SDK provider object.
 *
 * Keyed by **package name**, not by provider: every provider whose catalog
 * entry names one of these packages works with zero additional code. A new
 * package needs one entry here; a new provider needs none. This is why the
 * catalog may list hundreds of providers and this file knows five names.
 */
const SUPPORTED_PACKAGES: Record<string, PackageFactory> = {
  '@ai-sdk/openai-compatible': {
    createModel: async (resolved, modelId, fetch) => {
      const { createOpenAICompatible } = await import('@ai-sdk/openai-compatible');
      return createOpenAICompatible({
        name: resolved.id,
        ...providerAuth(resolved),
        baseURL: stripChatCompletions(resolved.baseURL ?? ''),
        includeUsage: true,
        ...resolved.options,
        ...(fetch ? { fetch: fetch as typeof fetch } : {}),
      }).chatModel(modelId);
    },
  },
  '@ai-sdk/openai': {
    createModel: async (resolved, modelId, fetch) => {
      const { createOpenAI } = await import('@ai-sdk/openai');
      return createOpenAI({
        ...providerAuth(resolved),
        ...(resolved.baseURL ? { baseURL: resolved.baseURL } : {}),
        ...resolved.options,
        ...(fetch ? { fetch: fetch as typeof fetch } : {}),
      }).languageModel(modelId);
    },
  },
  '@ai-sdk/anthropic': {
    createModel: async (resolved, modelId, fetch) => {
      const { createAnthropic } = await import('@ai-sdk/anthropic');
      return createAnthropic({
        ...providerAuth(resolved),
        ...(resolved.baseURL ? { baseURL: resolved.baseURL } : {}),
        ...resolved.options,
        ...(fetch ? { fetch: fetch as typeof fetch } : {}),
      }).languageModel(modelId);
    },
    supportsImageToolResult: () => true,
  },
  '@ai-sdk/google': {
    createModel: async (resolved, modelId, fetch) => {
      const { createGoogleGenerativeAI } = await import('@ai-sdk/google');
      return createGoogleGenerativeAI({
        ...providerAuth(resolved),
        ...(resolved.baseURL ? { baseURL: resolved.baseURL } : {}),
        ...resolved.options,
        ...(fetch ? { fetch: fetch as typeof fetch } : {}),
      }).chat(modelId);
    },
    supportsImageToolResult: (modelId) => /(^|\/)gemini-(?:3|[4-9]\d*)(?:[.-]|$)/i.test(modelId),
  },
  '@openrouter/ai-sdk-provider': {
    createModel: async (resolved, modelId, fetch) => {
      const { createOpenRouter } = await import('@openrouter/ai-sdk-provider');
      return createOpenRouter({
        ...providerAuth(resolved),
        ...(resolved.baseURL ? { baseURL: resolved.baseURL } : {}),
        ...resolved.options,
        ...(fetch ? { fetch: fetch as typeof fetch } : {}),
      }).languageModel(modelId);
    },
    supportsImageToolResult: () => true,
  },
  '@ai-sdk/groq': {
    createModel: async (resolved, modelId, fetch) => {
      const { createGroq } = await import('@ai-sdk/groq');
      return createGroq({
        ...providerAuth(resolved),
        ...(resolved.baseURL ? { baseURL: resolved.baseURL } : {}),
        ...resolved.options,
        ...(fetch ? { fetch: fetch as typeof fetch } : {}),
      }).languageModel(modelId);
    },
  },
  '@ai-sdk/cerebras': {
    createModel: async (resolved, modelId, fetch) => {
      const { createCerebras } = await import('@ai-sdk/cerebras');
      return createCerebras({
        ...providerAuth(resolved),
        ...(resolved.baseURL ? { baseURL: resolved.baseURL } : {}),
        ...resolved.options,
        ...(fetch ? { fetch: fetch as typeof fetch } : {}),
      }).languageModel(modelId);
    },
  },
  '@ai-sdk/xai': {
    createModel: async (resolved, modelId, fetch) => {
      const { createXai } = await import('@ai-sdk/xai');
      return createXai({
        ...providerAuth(resolved),
        ...(resolved.baseURL ? { baseURL: resolved.baseURL } : {}),
        ...resolved.options,
        ...(fetch ? { fetch: fetch as typeof fetch } : {}),
      }).languageModel(modelId);
    },
  },
  '@ai-sdk/deepinfra': {
    createModel: async (resolved, modelId, fetch) => {
      const { createDeepInfra } = await import('@ai-sdk/deepinfra');
      return createDeepInfra({
        ...providerAuth(resolved),
        ...(resolved.baseURL ? { baseURL: resolved.baseURL } : {}),
        ...resolved.options,
        ...(fetch ? { fetch: fetch as typeof fetch } : {}),
      }).languageModel(modelId);
    },
  },
  '@ai-sdk/togetherai': {
    createModel: async (resolved, modelId, fetch) => {
      const { createTogetherAI } = await import('@ai-sdk/togetherai');
      return createTogetherAI({
        ...providerAuth(resolved),
        ...(resolved.baseURL ? { baseURL: resolved.baseURL } : {}),
        ...resolved.options,
        ...(fetch ? { fetch: fetch as typeof fetch } : {}),
      }).languageModel(modelId);
    },
  },
  '@ai-sdk/mistral': {
    createModel: async (resolved, modelId, fetch) => {
      const { createMistral } = await import('@ai-sdk/mistral');
      return createMistral({
        ...providerAuth(resolved),
        ...(resolved.baseURL ? { baseURL: resolved.baseURL } : {}),
        ...resolved.options,
        ...(fetch ? { fetch: fetch as typeof fetch } : {}),
      }).languageModel(modelId);
    },
  },
  '@ai-sdk/cohere': {
    createModel: async (resolved, modelId, fetch) => {
      const { createCohere } = await import('@ai-sdk/cohere');
      return createCohere({
        ...providerAuth(resolved),
        ...(resolved.baseURL ? { baseURL: resolved.baseURL } : {}),
        ...resolved.options,
        ...(fetch ? { fetch: fetch as typeof fetch } : {}),
      }).languageModel(modelId);
    },
  },
  '@ai-sdk/gateway': {
    createModel: async (resolved, modelId, fetch) => {
      const { createGateway } = await import('@ai-sdk/gateway');
      return createGateway({
        ...providerAuth(resolved),
        ...(resolved.baseURL ? { baseURL: resolved.baseURL } : {}),
        ...resolved.options,
        ...(fetch ? { fetch: fetch as typeof fetch } : {}),
      }).languageModel(modelId);
    },
  },
};

/**
 * The catalog's `api` for an OpenAI-compatible provider is the full
 * `/chat/completions` URL; the SDK wants the base.
 */
function stripChatCompletions(rawUrl: string): string {
  return rawUrl.replace(/\/chat\/completions\/?$/i, '').replace(/\/+$/, '');
}

/** True when the named runtime package is installed and usable. */
export function isPackageSupported(npm: string): boolean {
  return npm in SUPPORTED_PACKAGES;
}

/** True when the package adapter preserves images inside tool-result content. */
export function supportsImageToolResult(resolved: ResolvedProvider, modelId: string): boolean {
  return SUPPORTED_PACKAGES[resolved.npm]?.supportsImageToolResult?.(modelId) ?? false;
}

/** Installed runtime packages, sorted. A custom provider can use any of these. */
export function listSupportedPackages(): string[] {
  return Object.keys(SUPPORTED_PACKAGES).sort();
}

/**
 * A factory for a package Ranite does not bundle.
 *
 * The package is installed on first use (see install.ts) and driven through the
 * AI SDK's own convention: a single `create*` export whose result exposes
 * `languageModel(id)`. No provider is named here, so any catalog provider whose
 * package follows the convention works.
 */
function dynamicFactory(npm: string): PackageFactory {
  return {
    createModel: async (resolved, modelId, fetch) => {
      const create = await importProviderFactory(npm);
      /* A package that reads its own credential is left to do so. Only one that
         cannot — `@ai-sdk/openai-compatible` and its kin — receives the key
         Ranite found. */
      const auth = resolved.apiKey && passesKeyToPackage(npm, resolved.apiKey) ? providerAuth(resolved) : {};
      const provider = create({
        name: resolved.id,
        ...auth,
        ...(resolved.baseURL ? { baseURL: resolved.baseURL } : {}),
        ...resolved.options,
        ...(fetch ? { fetch } : {}),
      }) as { languageModel?: (id: string) => LanguageModel };
      if (typeof provider.languageModel !== 'function') {
        throw new Error(`package "${npm}" returns no languageModel`);
      }
      return provider.languageModel(modelId);
    },
  };
}

/**
 * Builds the AI SDK language model for one provider id and model id.
 *
 * Returns a reason instead of throwing when the provider cannot run, so the
 * caller can list the alternatives rather than crash.
 */
export async function createLanguageModel(
  providerId: string,
  modelId: string,
  override?: ProviderOverride,
  fetch?: typeof globalThis.fetch,
): Promise<{ ok: true; model: LanguageModel; resolved: ResolvedProvider } | { ok: false; error: UnavailableProvider }> {
  const resolution = resolveProvider(providerId, override);
  if (!resolution.ok) return resolution;
  const { provider } = resolution;
  try {
    const factory = SUPPORTED_PACKAGES[provider.npm] ?? dynamicFactory(provider.npm);
    return { ok: true, model: await factory.createModel(provider, modelId, fetch), resolved: provider };
  } catch (error) {
    return {
      ok: false,
      error: {
        id: providerId,
        reason: `could not load provider "${providerId}" (package "${provider.npm}"): ${error instanceof Error ? error.message : String(error)}`,
      },
    };
  }
}

export interface ReasoningVariant {
  id: string;
  label: string;
  providerOptions: Record<string, Record<string, JSONValue>>;
}

/**
 * The reasoning wire format of one runtime package.
 *
 * Adapter knowledge lives here and only here: one table entry per npm
 * package. The exported helpers below delegate to this table so a newly
 * added adapter cannot end up half-mapped (model creation works, reasoning
 * silently degrades to Auto) the way a forgotten switch-case allows.
 */
interface ReasoningAdapter {
  /** providerOptions namespace, mirroring providerOptionsKey. */
  optionsKey: (provider: ResolvedProvider) => string | null;
  /** Effort value to request options, or null when the adapter has no effort control. */
  effort: (effort: string) => Record<string, unknown> | null;
  /** On/off toggle to request options, or null when the adapter has no toggle. */
  toggle: (enabled: boolean) => Record<string, unknown> | null;
  /** Token budget to request options, or null when the adapter has no budget control. */
  budget: (tokens: number) => Record<string, unknown> | null;
  /** Extra request options merged when reasoning is shown, or null for none. */
  display: (current: Record<string, unknown>) => Record<string, unknown> | null;
}

/** OpenAI-vocabulary efforts, shared by the OpenAI-parity adapters. */
const OPENAI_EFFORT_VALUES = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

const REASONING_ADAPTERS: Record<string, ReasoningAdapter> = {
  '@ai-sdk/openai-compatible': {
    optionsKey: (provider) => provider.id.split('.')[0] ?? provider.id,
    effort: (effort) => ({ reasoningEffort: effort }),
    toggle: () => null,
    budget: () => null,
    // OpenAI-compatible endpoints may stream reasoning_content without a
    // standard request flag; their selected models.dev effort stays in force.
    display: () => null,
  },
  '@ai-sdk/openai': {
    optionsKey: () => 'openai',
    effort: (effort) => (OPENAI_EFFORT_VALUES.includes(effort) ? { reasoningEffort: effort } : null),
    toggle: (enabled) => ({ reasoningEffort: enabled ? 'high' : 'none' }),
    budget: () => null,
    display: () => ({ reasoningSummary: 'auto' }),
  },
  '@ai-sdk/anthropic': {
    optionsKey: () => 'anthropic',
    effort: (effort) => {
      if (effort === 'none') return { thinking: { type: 'disabled' } };
      return ['low', 'medium', 'high', 'xhigh', 'max'].includes(effort)
        ? { thinking: { type: 'adaptive', display: 'omitted' }, effort }
        : null;
    },
    toggle: (enabled) => ({ thinking: enabled ? { type: 'adaptive', display: 'omitted' } : { type: 'disabled' } }),
    budget: (tokens) => ({ thinking: { type: 'enabled', budgetTokens: tokens } }),
    display: (current) => {
      const thinking =
        typeof current.thinking === 'object' && current.thinking !== null ? (current.thinking as Record<string, unknown>) : null;
      if (thinking?.type === 'disabled') return null;
      return { sendReasoning: true, ...(thinking ? { thinking: { ...thinking, display: 'summarized' } } : {}) };
    },
  },
  '@ai-sdk/google': {
    optionsKey: () => 'google',
    effort: (effort) => (['minimal', 'low', 'medium', 'high'].includes(effort) ? { thinkingConfig: { thinkingLevel: effort } } : null),
    toggle: (enabled) => (enabled ? null : { thinkingConfig: { thinkingBudget: 0 } }),
    budget: (tokens) => ({ thinkingConfig: { thinkingBudget: tokens } }),
    display: (current) => {
      const thinkingConfig =
        typeof current.thinkingConfig === 'object' && current.thinkingConfig !== null
          ? (current.thinkingConfig as Record<string, unknown>)
          : {};
      return { thinkingConfig: { ...thinkingConfig, includeThoughts: true } };
    },
  },
  '@openrouter/ai-sdk-provider': {
    optionsKey: () => 'openrouter',
    effort: (effort) => (['none', 'minimal', 'low', 'medium', 'high', 'xhigh'].includes(effort) ? { reasoning: { effort } } : null),
    toggle: (enabled) => ({ reasoning: { enabled, effort: enabled ? 'high' : 'none' } }),
    budget: (tokens) => ({ reasoning: { max_tokens: tokens } }),
    display: (current) => {
      const reasoning =
        typeof current.reasoning === 'object' && current.reasoning !== null ? (current.reasoning as Record<string, unknown>) : {};
      return { reasoning: { ...reasoning, exclude: false } };
    },
  },
  '@ai-sdk/gateway': {
    // UNVERIFIED live: @ai-sdk/gateway forwards providerOptions to the
    // Gateway API, which applies the serving provider's native entry, and
    // GatewayProviderOptions itself is routing-only (no reasoning field).
    // The vercel catalog entries use the OpenAI effort vocabulary, so effort
    // is sent OpenAI-parity and left to the gateway's cross-provider
    // translation. If the server ignores it, the server default applies and
    // nothing breaks; verify against a live gateway call before relying on
    // exact effort levels.
    optionsKey: () => 'openai',
    effort: (effort) => (OPENAI_EFFORT_VALUES.includes(effort) ? { reasoningEffort: effort } : null),
    toggle: (enabled) => ({ reasoningEffort: enabled ? 'high' : 'none' }),
    budget: () => null,
    display: () => null,
  },
};

/** The table entry for a runtime package, or null when the adapter has no reasoning mapping. */
function reasoningAdapter(npm: string): ReasoningAdapter | null {
  return REASONING_ADAPTERS[npm] ?? null;
}

/** Adds adapter-specific request options needed to receive visible reasoning. */
export function withReasoningVisibility(
  provider: ResolvedProvider,
  base: ReasoningVariant['providerOptions'],
  visible: boolean,
): ReasoningVariant['providerOptions'] {
  if (!visible) return base;
  const adapter = reasoningAdapter(provider.npm);
  const key = adapter?.optionsKey(provider) ?? null;
  if (!adapter || !key) return base;

  const current = base[key] ?? {};
  const display = adapter.display(current);
  return display ? { ...base, [key]: { ...current, ...display } as Record<string, Record<string, JSONValue>> } : base;
}

export interface ReasoningCatalogMatch {
  model: CatalogModel | null;
  sourceProviderId: string | null;
  inferred: boolean;
}

/** Finds exact metadata first, then a same-model catalog entry for custom providers. */
export function findReasoningCatalogMatch(providerId: string, modelId: string, provider: ResolvedProvider): ReasoningCatalogMatch {
  const exact = getModel(providerId, modelId);
  if (exact) return { model: exact, sourceProviderId: providerId, inferred: false };

  const candidates = listProviderIdsForModel(modelId).flatMap((sourceProviderId) => {
    const source = getProvider(sourceProviderId);
    const model = getModel(sourceProviderId, modelId);
    return model ? [{ sourceProviderId, npm: source?.npm, model }] : [];
  });
  candidates.sort((left, right) => {
    const score = (candidate: (typeof candidates)[number]) =>
      (candidate.model.reasoning_options?.length ? 0 : 4) +
      (candidate.model.reasoning === true ? 0 : 2) +
      (candidate.npm === provider.npm ? 0 : 1);
    return score(left) - score(right) || left.sourceProviderId.localeCompare(right.sourceProviderId);
  });
  const match = candidates[0];
  return match
    ? { model: match.model, sourceProviderId: match.sourceProviderId, inferred: true }
    : { model: null, sourceProviderId: null, inferred: false };
}

/** Resolves the input modalities from the selected model or a same-runtime mirror. */
export function modelInputModalities(providerId: string, modelId: string, provider: ResolvedProvider): string[] {
  const exact = getModel(providerId, modelId);
  const model =
    exact ??
    listProviderIdsForModel(modelId)
      .filter((sourceProviderId) => getProvider(sourceProviderId)?.npm === provider.npm)
      .map((sourceProviderId) => getModel(sourceProviderId, modelId))
      .find((candidate) => candidate !== undefined);
  const modalities = new Set(model?.modalities?.input ?? ['text']);
  if (model?.attachment === true) modalities.add('image');
  modalities.add('text');
  return [...modalities];
}

/** Resolves image support independently because a reasoning match may come from a non-vision mirror. */
export function modelSupportsVision(providerId: string, modelId: string, provider: ResolvedProvider): boolean {
  return modelInputModalities(providerId, modelId, provider).includes('image');
}

/**
 * Maps a stored reasoning preference to a current variant id.
 *
 * The implicit variant used to be `auto`; it is `default` now. Stored
 * settings may still say `auto`, so normalize at every read instead of
 * migrating user files.
 */
export function normalizeReasoningVariantId(variantId: string): string {
  return variantId === 'auto' ? 'default' : variantId;
}

/** Builds selectable settings from models.dev and the installed AI SDK adapter. */
export function listReasoningVariants(provider: ResolvedProvider, model: CatalogModel | null): ReasoningVariant[] {
  const variants: ReasoningVariant[] = [{ id: 'default', label: 'Default', providerOptions: {} }];
  if (model?.reasoning !== true || !model.reasoning_options?.length) return variants;

  const key = providerOptionsKey(provider);
  if (!key) return variants;
  const add = (id: string, label: string, options: Record<string, unknown> | null) => {
    if (!options || variants.some((variant) => variant.id === id)) return;
    variants.push({ id, label, providerOptions: { [key]: options } as Record<string, Record<string, JSONValue>> });
  };

  const effort = model.reasoning_options.find((option) => option.type === 'effort');
  const toggle = model.reasoning_options.some((option) => option.type === 'toggle');
  const budget = model.reasoning_options.find((option) => option.type === 'budget_tokens');

  if (toggle) add('none', 'Off', toggleOptions(provider.npm, false));
  if (effort) {
    for (const value of effort.values) {
      const id = value ?? 'none';
      add(id, id === 'none' ? 'Off' : capitalize(id), effortOptions(provider.npm, id));
    }
  }
  if (budget && !effort) {
    const outputLimit = model.limit?.output;
    const maximum = Math.min(budget.max ?? 32_000, outputLimit ? outputLimit - 1 : 32_000, 32_000);
    const minimum = Math.max(budget.min ?? 1, 1);
    if (maximum >= minimum) {
      const high = Math.min(maximum, Math.max(minimum, Math.floor((maximum + 1) / 2)));
      if (toggle) add('none', 'Off', toggleOptions(provider.npm, false));
      add(`budget-high-${high}`, `High · ${high.toLocaleString('en-US')} tokens`, budgetOptions(provider.npm, high));
      if (maximum !== high)
        add(`budget-max-${maximum}`, `Max · ${maximum.toLocaleString('en-US')} tokens`, budgetOptions(provider.npm, maximum));
    }
  }
  if (toggle && !effort && !budget) add('high', 'On', toggleOptions(provider.npm, true));
  return variants;
}

function providerOptionsKey(provider: ResolvedProvider): string | null {
  return reasoningAdapter(provider.npm)?.optionsKey(provider) ?? null;
}

function effortOptions(npm: string, effort: string): Record<string, unknown> | null {
  return reasoningAdapter(npm)?.effort(effort) ?? null;
}

function toggleOptions(npm: string, enabled: boolean): Record<string, unknown> | null {
  return reasoningAdapter(npm)?.toggle(enabled) ?? null;
}

function budgetOptions(npm: string, budgetTokens: number): Record<string, unknown> | null {
  return reasoningAdapter(npm)?.budget(budgetTokens) ?? null;
}

/**
 * Why the reasoning picker shows variants or not.
 *
 * `model-unsupported` means the catalog carries no reasoning metadata for
 * this model; `adapter-unmapped` means the metadata exists but Ranite has no
 * wire mapping for the runtime package yet. They used to share one message,
 * which made a missing adapter mapping look like a missing model.
 */
export type ReasoningSupport = 'available' | 'model-unsupported' | 'adapter-unmapped';

export function reasoningSupportStatus(provider: ResolvedProvider, model: CatalogModel | null): ReasoningSupport {
  if (model?.reasoning !== true || !model.reasoning_options?.length) return 'model-unsupported';
  return listReasoningVariants(provider, model).length > 1 ? 'available' : 'adapter-unmapped';
}

function capitalize(value: string): string {
  return value.length === 0 ? value : `${value[0]!.toUpperCase()}${value.slice(1)}`;
}

/**
 * How a model asks for a tool.
 *
 * Only `native` and `unsupported` exist. Ranite does not have an `inline` mode:
 * a model that writes its tool call into prose is a model whose instructions
 * have to be read out of text, and the runtime has to stay the thing that
 * decides what runs. `unknown` means the catalog has no opinion, which
 * `--list-models` treats as "do not offer".
 */
export type ToolCallMode = 'native' | 'unsupported' | 'unknown';

/**
 * Resolves a model's tool-call mode from the catalog.
 *
 * A provider the catalog does not carry cannot be checked from here at all, so
 * an endpoint the operator configured themselves is taken at its word: they
 * named the model, and there is nothing to compare that name against.
 */
export function toolCallMode(providerId: string, modelId: string, override?: ProviderOverride): ToolCallMode {
  const metadata = getModel(providerId, modelId);
  if (metadata?.tool_call === true) return 'native';
  if (metadata?.tool_call === false) return 'unsupported';
  if (!getProvider(providerId) && override?.npm) return 'native';
  return 'unknown';
}

/** True when this model can be used for a call that needs tools. */
export function canUseTools(providerId: string, modelId: string, override?: ProviderOverride): boolean {
  return toolCallMode(providerId, modelId, override) === 'native';
}

/** True only when the configured default resolves to a verified native tool-capable model. */
/**
 * True when a provider has any way to authenticate: a key or options in
 * settings, or a catalog-declared variable already set in the environment.
 *
 * This is the question every gate has to ask, and it is deliberately not the
 * same as "does settings hold a key". A provider that signs its own requests
 * (AWS) or reads a service account (Google Vertex) is configured the moment its
 * variables exist, whether or not Ranite was told about it.
 */
export function providerIsConfigured(providerId: string, state: ProviderState | undefined): boolean {
  if (hasCredential(state)) return true;
  return (getProvider(providerId)?.env ?? []).some((name) => (process.env[name] ?? '').trim().length > 0);
}

export function defaultModelIsUsable(settings: SettingsStore): boolean {
  const { defaultProvider, defaultModel } = settings;
  if (!defaultProvider || !defaultModel) return false;
  const state = settings.providers[defaultProvider];
  if (!state || !state.enabled || !providerIsConfigured(defaultProvider, state)) return false;
  const custom = Boolean(state.npm) || Boolean(state.url);
  if (!isCatalogLoaded() && !custom) return false;
  return canUseTools(defaultProvider, defaultModel, state);
}

export interface RoutableModel {
  providerId: string;
  model: string;
}

/**
 * Every model ranite will actually offer, derived from data alone.
 *
 * The filter is the catalog's own `tool_call` flag. Ranite is an agent: a model
 * that cannot call a tool is not a worse option, it is not an option, and
 * offering it would produce a session where the model can only talk.
 */
export function listToolCapableModels(providerIds: readonly string[], overrides: Record<string, ProviderOverride> = {}): RoutableModel[] {
  const out: RoutableModel[] = [];
  for (const providerId of providerIds) {
    const override = overrides[providerId];
    const models = getProvider(providerId)?.models;
    /* A provider the catalog does not carry has no list to offer; the operator
       named the one model it serves, and that is not a list. */
    if (!models) continue;
    for (const model of Object.keys(models)) {
      if (canUseTools(providerId, model, override)) out.push({ providerId, model });
    }
  }
  return out;
}
