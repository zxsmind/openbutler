import type { InboxRequest } from './inbox.js';
import type { ParentMessageInput } from './worker-records.js';
import { canonicalScopeRoot as canonicalWorkspaceRoot } from './workspace-origin.js';
import type { LanguageModel } from 'ai';
import { getCatalogIndex, getCatalogRevision, isCatalogLoaded } from './provider/catalog.js';
import { resolveModelName, resolveProviderName } from './provider/model-presentation.js';
import {
  createLanguageModel,
  defaultModelIsUsable,
  findReasoningCatalogMatch,
  listReasoningVariants,
  mergeProviderOptions,
  minimalReasoningOptions,
  modelInputModalities,
  modelIsUsable,
  modelSupportsVision,
  normalizeReasoningVariantId,
  providerIsConfigured,
  reasoningSummaryTitles,
  reasoningSupportStatus,
  resolveReasoningVariant,
  routingProviderOptions,
  settingsEffortVariants,
  supportsImageToolResult,
  type ResolvedProvider,
  withReasoningVisibility,
} from './provider/registry.js';
import { createPayloadFetch } from './provider/request-payload.js';
import { resolveDefaultModel } from './usage/default-model.js';
import {
  loadSettings,
  providerModelRouting,
  rememberProviderModel,
  saveSettings,
  type ApprovalMode,
  type SettingsStore,
} from './settings.js';
import type { RetryEvent } from './provider/retry.js';
import type { AgentEnvironment } from './agent-session.js';
import type { UsageRecordInput } from './usage/recorder.js';
import type { SubagentRequest } from './tools/subagent.js';
import type { McpConnectionManager } from './tools/mcp.js';

/** A session cannot manage its context safely without a verified model limit.
 * Never silently invent an arbitrary 8k/32k window for unknown providers.
 */
export function requireModelContextWindow(value: number | null | undefined, providerId: string, modelId: string): number {
  if (value === undefined || value === null || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(
      `The context limit for ${providerId}/${modelId} is unknown. Configure providers.${providerId}.modelSpecs.${modelId}.context in settings, or choose a cataloged model. Automatic compaction requires an explicit model context limit.`,
    );
  }
  return value;
}

export interface CreateAgentRuntimeOptions {
  workspaceRoot?: string;
  /** Restore a conversation's model without changing the machine's defaults. */
  initialModel?: { providerId: string; modelId: string };
  /** Interactive chats open before external tools connect; the first turn prepares them. */
  deferMcp?: boolean;
  /** Borrowed from the daemon; closing a chat never closes shared transports. */
  mcpManager?: McpConnectionManager;
  onMcpError?: (serverId: string, message: string) => void;
  onMcpConnected?: (serverId: string, toolCount: number) => void;
  backgroundManage?: (input: Record<string, unknown>, workspaceRoot: string, senderSessionId: string | undefined) => Promise<unknown>;
  inbox?: (request: InboxRequest, sessionId: string | undefined) => Promise<unknown>;
  ownerMessageSend?: (input: Record<string, unknown>, workspaceRoot: string, senderSessionId?: string) => Promise<unknown>;
  teamDelivery?: (input: Record<string, unknown>) => Promise<unknown>;
  teamSend?: (input: { recipient: string; text: string; replyTo?: string }) => Promise<unknown>;
  teamGroup?: (limit: number, acknowledge?: number) => Promise<unknown>;
  teamHistory?: (query: { scope: 'group' | 'dm'; peer?: string; before?: number; limit?: number }) => Promise<unknown>;
  teamStatus?: () => Promise<unknown>;
  teamSendFile?: (input: { path: string; to: string }) => Promise<unknown>;
  teamReceiveFile?: (input: { id: string; to?: string }) => Promise<unknown>;
  teamFiles?: () => Promise<unknown>;
  teamProfile?: (input: Record<string, unknown>) => Promise<unknown>;
  teamWork?: (input: Record<string, unknown>) => Promise<unknown>;
  teamRemember?: (input: { topic: 'decisions' | 'shared'; text: string }) => Promise<unknown>;
  sessionMessage?: (input: Record<string, unknown>, senderSessionId: string | undefined) => Promise<unknown> | unknown;
  subagent?: (request: SubagentRequest, senderSessionId: string | undefined, signal?: AbortSignal) => Promise<unknown> | unknown;
  parentMessage?: (input: ParentMessageInput, senderSessionId: string | undefined) => Promise<unknown> | unknown;
  subagentStop?: (input: { session: string }, senderSessionId: string | undefined) => Promise<unknown> | unknown;
  /** Writes one accounting row per model request; supplied by whoever owns the ledger. */
  recordUsage?: (input: UsageRecordInput, id: string) => void;
}

/** Creates the shared model/tool runtime without depending on a terminal UI. */
export async function createAgentRuntime(options: CreateAgentRuntimeOptions = {}): Promise<AgentEnvironment> {
  const settings = loadSettings();
  // A session's initial model wins; otherwise the default is explicit or, when
  // unset, the most-used usable model from recorded usage.
  const defaultChoice = options.initialModel ?? resolveDefaultModel(settings);
  const providerId = defaultChoice?.providerId ?? '';
  const modelId = defaultChoice?.modelId ?? '';
  const provider = settings.providers[providerId];
  if (!providerId || !modelId || !provider?.enabled || !providerIsConfigured(providerId, provider)) {
    throw new Error('No ready default provider and model. Run `openbutler setup` first.');
  }

  const { MemoryIndex, isMemoryEmbeddingModelPrepared } = await import('./memory-index.js');
  if (!(await isMemoryEmbeddingModelPrepared().catch(() => false))) {
    const { ensureMemoryModelPreparation } = await import('./memory-model-preparation.js');
    ensureMemoryModelPreparation();
  }

  if (!provider.npm) await getCatalogIndex();
  else {
    try {
      await getCatalogIndex();
    } catch {
      // Custom endpoints remain usable when models.dev is unavailable.
    }
  }

  if (!defaultModelIsUsable({ ...settings, defaultProvider: providerId, defaultModel: modelId })) {
    throw new Error('The default model is not ready. Configure its provider and model: openbutler setup');
  }
  // Retry and key-rotation events surface through here so the session can show
  // them in the transcript; the handler is swapped per run.
  const retryRelay: { handler: ((event: RetryEvent) => void) | null } = { handler: null };
  const reportRetry = (event: RetryEvent) => retryRelay.handler?.(event);

  const resolved = await createLanguageModel(providerId, modelId, provider, createPayloadFetch(provider, modelId), reportRetry);
  if (!resolved.ok) throw new Error(resolved.error.reason);
  const reasoningCatalog = findReasoningCatalogMatch(providerId, modelId, resolved.resolved);
  const contextWindowTokens = requireModelContextWindow(
    reasoningCatalog.model?.limit?.context ?? provider.modelSpecs?.[modelId]?.context,
    providerId,
    modelId,
  );
  const catalogVariants = listReasoningVariants(resolved.resolved, reasoningCatalog.model);
  const reasoningVariants = [
    ...catalogVariants,
    ...settingsEffortVariants(resolved.resolved, provider.modelSpecs?.[modelId]?.reasoning?.efforts ?? []).filter(
      (variant) => !catalogVariants.some((existing) => existing.id === variant.id),
    ),
  ];

  async function loadReviewer(latest: SettingsStore): Promise<{
    resolved: ResolvedProvider | null;
    catalogModel: typeof reasoningCatalog.model;
    model: LanguageModel | null;
    routing: ReturnType<typeof routingProviderOptions>;
  }> {
    if (!latest.autoReviewProvider || !latest.autoReviewModel) return { resolved: null, catalogModel: null, model: null, routing: {} };
    if (!modelIsUsable(latest, latest.autoReviewProvider, latest.autoReviewModel))
      throw new Error('The configured auto-review provider/model is not ready.');
    const built = await createLanguageModel(
      latest.autoReviewProvider,
      latest.autoReviewModel,
      latest.providers[latest.autoReviewProvider],
      createPayloadFetch(latest.providers[latest.autoReviewProvider], latest.autoReviewModel),
    );
    if (!built.ok) throw new Error(built.error.reason);
    return {
      resolved: built.resolved,
      catalogModel: findReasoningCatalogMatch(latest.autoReviewProvider, latest.autoReviewModel, built.resolved).model,
      model: built.model,
      routing: routingProviderOptions(
        built.resolved,
        providerModelRouting(latest.providers[latest.autoReviewProvider], latest.autoReviewModel),
      ),
    };
  }
  const reviewerConfig = (latest: SettingsStore) =>
    JSON.stringify([
      latest.autoReviewProvider,
      latest.autoReviewModel,
      latest.autoReviewProvider ? latest.providers[latest.autoReviewProvider] : undefined,
      getCatalogRevision(),
    ]);
  let reviewer = await loadReviewer(settings);
  let appliedReviewerConfig = reviewerConfig(settings);
  let workspaceRoot = canonicalWorkspaceRoot(options.workspaceRoot ?? process.cwd());
  const { ToolRegistry } = await import('./tools/registry.js');
  let memoryIndex = new MemoryIndex(workspaceRoot);
  let workspaceSwitch = Promise.resolve();
  let activeInputModalities = modelInputModalities(providerId, modelId, resolved.resolved);
  let mcp: Awaited<ReturnType<(typeof import('./tools/mcp.js'))['connectMcpServers']>> | null = null;
  let mcpReady = options.mcpManager ? false : options.deferMcp !== true;

  try {
    const [{ connectMcpServers }, { createToolCatalogue }] = await Promise.all([import('./tools/mcp.js'), import('./tools/catalog.js')]);
    mcp =
      options.mcpManager ??
      (await connectMcpServers(mcpReady ? settings.mcpServers : {}, {
        onError: options.onMcpError ?? (() => {}),
        onConnected: options.onMcpConnected ?? (() => {}),
        inputModalities: () => activeInputModalities,
      }));
    function createRegistry(inputModalities: readonly string[], scopeRoot = workspaceRoot, scopeMemoryIndex = memoryIndex) {
      const registry = new ToolRegistry();
      for (const definition of createToolCatalogue({
        workspaceRoot: scopeRoot,
        inputModalities,
        memoryIndex: scopeMemoryIndex,
        mcp: mcp!,
        onMcpConnectionsChanged: () => {
          runtime.registry = createRegistry(activeInputModalities);
        },
        ...(options.backgroundManage ? { backgroundManage: options.backgroundManage } : {}),
        ...(options.inbox ? { inbox: options.inbox } : {}),
        ...(options.ownerMessageSend ? { ownerMessageSend: options.ownerMessageSend } : {}),
        ...(options.teamDelivery ? { teamDelivery: options.teamDelivery } : {}),
        ...(options.teamSend ? { teamSend: options.teamSend } : {}),
        ...(options.teamGroup ? { teamGroup: options.teamGroup } : {}),
        ...(options.teamHistory ? { teamHistory: options.teamHistory } : {}),
        ...(options.teamStatus ? { teamStatus: options.teamStatus } : {}),
        ...(options.teamSendFile ? { teamSendFile: options.teamSendFile } : {}),
        ...(options.teamReceiveFile ? { teamReceiveFile: options.teamReceiveFile } : {}),
        ...(options.teamFiles ? { teamFiles: options.teamFiles } : {}),
        ...(options.teamProfile ? { teamProfile: options.teamProfile } : {}),
        ...(options.teamWork ? { teamWork: options.teamWork } : {}),
        ...(options.teamRemember ? { teamRemember: options.teamRemember } : {}),
        ...(options.sessionMessage ? { sessionMessage: options.sessionMessage } : {}),
        ...(options.subagent ? { subagent: options.subagent } : {}),
        ...(options.parentMessage ? { parentMessage: options.parentMessage } : {}),
        ...(options.subagentStop ? { subagentStop: options.subagentStop } : {}),
      })) {
        registry.register(definition);
      }
      return registry;
    }
    let activeResolved = resolved.resolved;
    let activeCatalog = reasoningCatalog;
    let activeVariants = reasoningVariants;
    let activeRouting = routingProviderOptions(resolved.resolved, providerModelRouting(provider, modelId));
    const modelConfig = (latest: SettingsStore) =>
      JSON.stringify([runtime.providerId, runtime.modelId, latest.providers[runtime.providerId], getCatalogRevision()]);
    let appliedModelConfig = JSON.stringify([providerId, modelId, provider, getCatalogRevision()]);
    let settingsReload = Promise.resolve();
    let appliedMcpRevision = mcp.revision;
    let runtimeClosed = false;
    async function applyModel(nextSettings: SettingsStore, nextProviderId: string, nextModelId: string) {
      const nextProvider = nextSettings.providers[nextProviderId];
      // Model activation uses the last committed local catalog. An expired TTL
      // must not make a session switch wait for the network refresh timeout.
      if (!isCatalogLoaded()) {
        try {
          await getCatalogIndex();
        } catch (error) {
          if (!nextProvider?.npm) throw error;
        }
      }
      if (!modelIsUsable(nextSettings, nextProviderId, nextModelId))
        throw new Error(`Provider ${nextProviderId} is disabled or not configured.`);
      const next = await createLanguageModel(
        nextProviderId,
        nextModelId,
        nextProvider,
        createPayloadFetch(nextProvider, nextModelId),
        reportRetry,
      );
      if (!next.ok) throw new Error(next.error.reason);
      const nextCatalog = findReasoningCatalogMatch(nextProviderId, nextModelId, next.resolved);
      const nextContextWindowTokens = requireModelContextWindow(
        nextCatalog.model?.limit?.context ?? nextProvider.modelSpecs?.[nextModelId]?.context,
        nextProviderId,
        nextModelId,
      );
      const nextCatalogVariants = listReasoningVariants(next.resolved, nextCatalog.model);
      const nextVariants = [
        ...nextCatalogVariants,
        ...settingsEffortVariants(next.resolved, nextProvider.modelSpecs?.[nextModelId]?.reasoning?.efforts ?? []).filter(
          (variant) => !nextCatalogVariants.some((existing) => existing.id === variant.id),
        ),
      ];
      const nextInputModalities = modelInputModalities(nextProviderId, nextModelId, next.resolved);
      const nextRegistry = createRegistry(nextInputModalities);

      activeResolved = next.resolved;
      activeCatalog = nextCatalog;
      activeVariants = nextVariants;
      activeRouting = routingProviderOptions(next.resolved, providerModelRouting(nextProvider, nextModelId));
      activeInputModalities = nextInputModalities;
      runtime.model = next.model;
      runtime.modelName = resolveModelName(nextProviderId, nextModelId);
      runtime.providerName = resolveProviderName(nextProviderId);
      runtime.providerId = nextProviderId;
      runtime.modelId = nextModelId;
      runtime.contextWindowTokens = nextContextWindowTokens;
      runtime.outputLimitTokens = nextCatalog.model?.limit?.output ?? nextProvider.modelSpecs?.[nextModelId]?.output ?? null;
      runtime.supportsVision = modelSupportsVision(nextProviderId, nextModelId, next.resolved);
      runtime.supportsImageToolResult = supportsImageToolResult(next.resolved, nextModelId);
      runtime.reasoningVariants = nextVariants;
      runtime.reasoningTitles = reasoningSummaryTitles(next.resolved);
      runtime.reasoningMetadataSource = nextCatalog.inferred ? nextCatalog.sourceProviderId : null;
      runtime.reasoningSupport = reasoningSupportStatus(next.resolved, nextCatalog.model);
      runtime.reasoningDefault = resolveReasoningVariant(nextVariants, nextSettings.reasoning ?? 'default').id;
      runtime.registry = nextRegistry;
      appliedModelConfig = modelConfig(nextSettings);
    }
    const runtime: AgentEnvironment = {
      model: resolved.model,
      ...(reviewer.model ? { reviewModel: reviewer.model } : {}),
      get workspaceRoot() {
        return workspaceRoot;
      },
      modelName: resolveModelName(providerId, modelId),
      providerName: resolveProviderName(providerId),
      providerId,
      modelId,
      contextWindowTokens,
      outputLimitTokens: reasoningCatalog.model?.limit?.output ?? provider.modelSpecs?.[modelId]?.output ?? null,
      supportsVision: modelSupportsVision(providerId, modelId, activeResolved),
      supportsImageToolResult: supportsImageToolResult(resolved.resolved, modelId),
      disableImageInput: () => {
        runtime.supportsVision = false;
        if (!activeInputModalities.includes('image')) return;
        const nextInputModalities = activeInputModalities.filter((modality) => modality !== 'image');
        const nextRegistry = createRegistry(nextInputModalities);
        activeInputModalities = nextInputModalities;
        runtime.registry = nextRegistry;
      },
      reasoningVariants,
      reasoningTitles: reasoningSummaryTitles(resolved.resolved),
      reasoningMetadataSource: activeCatalog.inferred ? activeCatalog.sourceProviderId : null,
      reasoningSupport: reasoningSupportStatus(resolved.resolved, reasoningCatalog.model),
      reasoningDefault: resolveReasoningVariant(reasoningVariants, settings.reasoning ?? 'default').id,
      saveReasoningPreference: (variantId) => {
        const latest = loadSettings();
        latest.reasoning = normalizeReasoningVariantId(variantId);
        saveSettings(latest);
        runtime.reasoningDefault = resolveReasoningVariant(activeVariants, latest.reasoning).id;
      },
      showReasoningDefault: settings.showReasoning !== false,
      approvalMode: settings.approvalMode,
      saveApprovalModePreference: (mode: ApprovalMode) => {
        const latest = loadSettings();
        latest.approvalMode = mode;
        saveSettings(latest);
        runtime.approvalMode = mode;
      },
      reportRetry: (handler) => {
        retryRelay.handler = handler;
      },
      saveShowReasoningPreference: (visible) => {
        const latest = loadSettings();
        latest.showReasoning = visible;
        saveSettings(latest);
        runtime.showReasoningDefault = visible;
      },
      getReasoningProviderOptions: (variantId, visible) => {
        const effective = resolveReasoningVariant(activeVariants, variantId);
        return mergeProviderOptions(withReasoningVisibility(activeResolved, effective.providerOptions, visible), activeRouting);
      },
      getReviewProviderOptions: () =>
        mergeProviderOptions(
          reviewer.resolved
            ? (minimalReasoningOptions(reviewer.resolved, reviewer.catalogModel) ?? {})
            : (minimalReasoningOptions(activeResolved, activeCatalog.model) ?? {}),
          reviewer.resolved ? reviewer.routing : activeRouting,
        ),
      registry: createRegistry(activeInputModalities),
      ...(options.recordUsage ? { recordUsage: options.recordUsage } : {}),

      getPeerCapabilities: () => ({
        platform: process.platform,
        mcpServers: mcp!
          .list()
          .filter((server) => server.connected)
          .map((server) => ({ name: server.id, toolCount: server.toolCount })),
        mcpTools: mcp!.tools.map((tool) => `${tool.providerId}/${tool.name}`),
      }),
      selectWorkspaceRoot: async (path) => {
        const run = workspaceSwitch.then(async () => {
          const nextRoot = canonicalWorkspaceRoot(path);
          if (nextRoot === workspaceRoot) return;
          const nextMemoryIndex = new MemoryIndex(nextRoot);
          let nextRegistry: ReturnType<typeof createRegistry>;
          try {
            nextRegistry = createRegistry(activeInputModalities, nextRoot, nextMemoryIndex);
          } catch (error) {
            await nextMemoryIndex.close();
            throw error;
          }
          const previousMemoryIndex = memoryIndex;
          workspaceRoot = nextRoot;
          memoryIndex = nextMemoryIndex;
          runtime.registry = nextRegistry;
          await previousMemoryIndex.close();
        });
        workspaceSwitch = run.catch(() => {});
        await run;
      },
      restoreModel: async (nextProviderId, nextModelId) => {
        const restore = settingsReload.then(async () => {
          if (runtimeClosed) throw new Error('The runtime is closed.');
          if (runtime.providerId === nextProviderId && runtime.modelId === nextModelId) return;
          await applyModel(loadSettings(), nextProviderId, nextModelId);
        });
        settingsReload = restore.catch(() => {});
        await restore;
      },
      selectModel: async (nextProviderId, nextModelId) => {
        const select = settingsReload.then(async () => {
          if (runtimeClosed) throw new Error('The runtime is closed.');
          const latest = loadSettings();
          await applyModel(latest, nextProviderId, nextModelId);
          // A selection belongs to this session: the global default changes only
          // through the explicit settings commands, never by picking a model.
          rememberProviderModel(latest, latest.defaultProvider, latest.defaultModel);
          rememberProviderModel(latest, nextProviderId, nextModelId);
          saveSettings(latest);
        });
        settingsReload = select.catch(() => {});
        await select;
      },
      prepareForTurn: async () => {
        if (mcpReady) return;
        mcpReady = true;
        try {
          await runtime.reloadSettings!(true);
        } catch (error) {
          mcpReady = false;
          throw error;
        }
      },
      reloadSettings: (reloadTools = false) => {
        const reload = settingsReload.then(async () => {
          if (runtimeClosed) return;
          const latest = loadSettings();
          // Validate/build before publishing new model state. An invalid edit never
          // overwrites the files or silently falls back to removed credentials.
          const nextReviewerConfig = reviewerConfig(latest);
          const nextReviewer = nextReviewerConfig === appliedReviewerConfig ? reviewer : await loadReviewer(latest);
          if (modelConfig(latest) !== appliedModelConfig) await applyModel(latest, runtime.providerId, runtime.modelId);
          reviewer = nextReviewer;
          appliedReviewerConfig = nextReviewerConfig;
          if (reviewer.model) runtime.reviewModel = reviewer.model;
          else delete runtime.reviewModel;
          runtime.reasoningDefault = resolveReasoningVariant(activeVariants, latest.reasoning ?? 'default').id;
          runtime.showReasoningDefault = latest.showReasoning !== false;
          runtime.approvalMode = latest.approvalMode;
          const toolsChanged = reloadTools && mcpReady && (await mcp!.reload(latest.mcpServers));
          if (toolsChanged || mcp!.revision !== appliedMcpRevision) {
            runtime.registry = createRegistry(activeInputModalities);
            appliedMcpRevision = mcp!.revision;
          }
        });
        settingsReload = reload.catch(() => {});
        return reload;
      },
      close: async () => {
        runtimeClosed = true;
        await settingsReload;
        try {
          await memoryIndex.close();
        } finally {
          if (!options.mcpManager) await mcp?.close();
        }
      },
    };
    return runtime;
  } catch (error) {
    try {
      await memoryIndex.close();
    } finally {
      if (!options.mcpManager) await mcp?.close();
    }
    throw error;
  }
}
