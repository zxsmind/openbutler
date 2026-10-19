import type { InboxRequest } from './inbox.js';
import type { ParentMessageInput } from './worker-records.js';
import { realpathSync, statSync } from 'node:fs';
import type { LanguageModel } from 'ai';
import { getCatalogIndex } from './provider/catalog.js';
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
  reasoningSupportStatus,
  resolveReasoningVariant,
  routingProviderOptions,
  supportsImageToolResult,
  withReasoningVisibility,
} from './provider/registry.js';
import { loadSettings, rememberProviderModel, saveSettings, type ApprovalMode } from './settings.js';
import type { RetryEvent } from './provider/retry.js';
import type { AgentEnvironment } from './agent-session.js';
import type { SubagentRequest } from './tools/subagent.js';

export interface CreateAgentRuntimeOptions {
  workspaceRoot?: string;
  onMcpError?: (serverId: string, message: string) => void;
  onMcpConnected?: (serverId: string, toolCount: number) => void;
  backgroundManage?: (input: Record<string, unknown>, workspaceRoot: string, senderSessionId: string | undefined) => Promise<unknown>;
  inbox?: (request: InboxRequest, sessionId: string | undefined) => Promise<unknown>;
  ownerMessageSend?: (input: Record<string, unknown>, workspaceRoot: string) => Promise<unknown>;
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
}

/** Creates the shared model/tool runtime without depending on a terminal UI. */
export async function createAgentRuntime(options: CreateAgentRuntimeOptions = {}): Promise<AgentEnvironment> {
  const settings = loadSettings();
  const providerId = settings.defaultProvider;
  const modelId = settings.defaultModel;
  const provider = settings.providers[providerId];
  if (!providerId || !modelId || !provider?.enabled || !providerIsConfigured(providerId, provider)) {
    throw new Error('No ready default provider and model. Run `ranite setup` first.');
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

  if (!defaultModelIsUsable(settings)) {
    throw new Error('The default model is not verified for native tool calls. Choose a tool-capable model: ranite setup');
  }
  // Retry and key-rotation events surface through here so the session can show
  // them in the transcript; the handler is swapped per run.
  const retryRelay: { handler: ((event: RetryEvent) => void) | null } = { handler: null };
  const reportRetry = (event: RetryEvent) => retryRelay.handler?.(event);

  const resolved = await createLanguageModel(providerId, modelId, provider, undefined, reportRetry);
  if (!resolved.ok) throw new Error(resolved.error.reason);
  const reasoningCatalog = findReasoningCatalogMatch(providerId, modelId, resolved.resolved);
  const reasoningVariants = listReasoningVariants(resolved.resolved, reasoningCatalog.model);

  // The permission reviewer may run on a different provider/model than the main
  // one, so a model that is unreliable at forced tool calls can be swapped out
  // without touching the session model. Resolved once at host start.
  let reviewResolved: typeof resolved.resolved | null = null;
  let reviewCatalogModel: typeof reasoningCatalog.model = null;
  let reviewModel: LanguageModel | null = null;
  let reviewRouting: ReturnType<typeof routingProviderOptions> = {};
  if (settings.autoReviewProvider && settings.autoReviewModel) {
    if (!modelIsUsable(settings, settings.autoReviewProvider, settings.autoReviewModel)) {
      throw new Error(
        `Auto-review model ${settings.autoReviewProvider}/${settings.autoReviewModel} is not usable. ` +
          `Check its provider key and that the model supports native tool calls, or clear it with \`ranite permissions --review-model none\`.`,
      );
    }
    const built = await createLanguageModel(
      settings.autoReviewProvider,
      settings.autoReviewModel,
      settings.providers[settings.autoReviewProvider],
    );
    if (!built.ok) throw new Error(built.error.reason);
    reviewResolved = built.resolved;
    reviewCatalogModel = findReasoningCatalogMatch(settings.autoReviewProvider, settings.autoReviewModel, built.resolved).model;
    reviewModel = built.model;
    reviewRouting = routingProviderOptions(built.resolved, settings.providers[settings.autoReviewProvider]?.routing);
  }
  let workspaceRoot = canonicalWorkspaceRoot(options.workspaceRoot ?? process.cwd());
  const { ToolRegistry } = await import('./tools/registry.js');
  let memoryIndex = new MemoryIndex(workspaceRoot);
  let workspaceSwitch = Promise.resolve();
  let activeInputModalities = modelInputModalities(providerId, modelId, resolved.resolved);
  let mcp: Awaited<ReturnType<(typeof import('./tools/mcp.js'))['connectMcpServers']>> | null = null;

  try {
    const [{ connectMcpServers }, { createToolCatalogue }] = await Promise.all([import('./tools/mcp.js'), import('./tools/catalog.js')]);
    mcp = await connectMcpServers(settings.mcpServers, {
      onError: options.onMcpError ?? (() => {}),
      onConnected: options.onMcpConnected ?? (() => {}),
      inputModalities: () => activeInputModalities,
    });
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
    let activeRouting = routingProviderOptions(resolved.resolved, provider.routing);
    const runtime: AgentEnvironment = {
      model: resolved.model,
      ...(reviewModel ? { reviewModel } : {}),
      get workspaceRoot() {
        return workspaceRoot;
      },
      modelName: resolved.resolved.displayName,
      providerId,
      modelId,
      contextWindowTokens: reasoningCatalog.model?.limit?.context ?? null,
      outputLimitTokens: reasoningCatalog.model?.limit?.output ?? null,
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
          reviewResolved
            ? (minimalReasoningOptions(reviewResolved, reviewCatalogModel) ?? {})
            : (minimalReasoningOptions(activeResolved, activeCatalog.model) ?? {}),
          reviewResolved ? reviewRouting : activeRouting,
        ),
      registry: createRegistry(activeInputModalities),
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
      selectModel: async (nextProviderId, nextModelId) => {
        const nextSettings = loadSettings();
        const nextProvider = nextSettings.providers[nextProviderId];
        if (!nextProvider?.enabled || !providerIsConfigured(nextProviderId, nextProvider)) {
          throw new Error(`Provider ${nextProviderId} needs an enabled API key.`);
        }
        rememberProviderModel(nextSettings, nextSettings.defaultProvider, nextSettings.defaultModel);
        rememberProviderModel(nextSettings, nextProviderId, nextModelId);
        nextSettings.defaultProvider = nextProviderId;
        nextSettings.defaultModel = nextModelId;
        if (!defaultModelIsUsable(nextSettings)) {
          throw new Error(`Model ${nextModelId} is not available for tool calls.`);
        }
        const next = await createLanguageModel(nextProviderId, nextModelId, nextProvider);
        if (!next.ok) throw new Error(next.error.reason);
        const nextCatalog = findReasoningCatalogMatch(nextProviderId, nextModelId, next.resolved);
        const nextVariants = listReasoningVariants(next.resolved, nextCatalog.model);
        const nextInputModalities = modelInputModalities(nextProviderId, nextModelId, next.resolved);
        const nextRegistry = createRegistry(nextInputModalities);
        saveSettings(nextSettings);

        activeResolved = next.resolved;
        activeCatalog = nextCatalog;
        activeVariants = nextVariants;
        activeRouting = routingProviderOptions(next.resolved, nextProvider.routing);
        activeInputModalities = nextInputModalities;
        runtime.model = next.model;
        runtime.modelName = next.resolved.displayName;
        runtime.providerId = nextProviderId;
        runtime.modelId = nextModelId;
        runtime.contextWindowTokens = nextCatalog.model?.limit?.context ?? null;
        runtime.outputLimitTokens = nextCatalog.model?.limit?.output ?? null;
        runtime.supportsVision = modelSupportsVision(nextProviderId, nextModelId, next.resolved);
        runtime.supportsImageToolResult = supportsImageToolResult(next.resolved, nextModelId);
        runtime.reasoningVariants = nextVariants;
        runtime.reasoningMetadataSource = nextCatalog.inferred ? nextCatalog.sourceProviderId : null;
        runtime.reasoningSupport = reasoningSupportStatus(next.resolved, nextCatalog.model);
        runtime.reasoningDefault = resolveReasoningVariant(nextVariants, nextSettings.reasoning ?? 'default').id;
        runtime.registry = nextRegistry;
      },
      close: async () => {
        try {
          await memoryIndex.close();
        } finally {
          await mcp?.close();
        }
      },
    };
    return runtime;
  } catch (error) {
    try {
      await memoryIndex.close();
    } finally {
      await mcp?.close();
    }
    throw error;
  }
}

function canonicalWorkspaceRoot(path: string): string {
  const resolved = realpathSync(path);
  if (!statSync(resolved).isDirectory()) throw new Error(`Workspace root is not a directory: ${resolved}`);
  return resolved;
}
