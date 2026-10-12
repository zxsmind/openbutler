import { realpathSync, statSync } from 'node:fs';
import { getCatalogIndex } from './provider/catalog.js';
import {
  createLanguageModel,
  defaultModelIsUsable,
  findReasoningCatalogMatch,
  listReasoningVariants,
  modelInputModalities,
  modelSupportsVision,
  providerIsConfigured,
  supportsImageToolResult,
  withReasoningVisibility,
} from './provider/registry.js';
import { loadSettings, rememberProviderModel, saveSettings, type ApprovalMode } from './settings.js';
import type { AgentEnvironment } from './agent-session.js';
import type { McpServerRequest } from './tools/mcp.js';
import type { SubagentRequest } from './tools/subagent.js';

export interface CreateAgentRuntimeOptions {
  workspaceRoot?: string;
  approveMcpServer?: (request: McpServerRequest) => Promise<boolean>;
  onMcpError?: (serverId: string, message: string) => void;
  onMcpConnected?: (serverId: string, toolCount: number) => void;
  backgroundManage?: (input: Record<string, unknown>, workspaceRoot: string) => Promise<unknown>;
  ownerMessageSend?: (input: Record<string, unknown>, workspaceRoot: string) => Promise<unknown>;
  ownerInboxRead?: (limit: number, acknowledge?: string[]) => Promise<unknown>;
  sessionMessage?: (input: Record<string, unknown>, senderSessionId: string | undefined) => Promise<unknown> | unknown;
  subagent?: (request: SubagentRequest, senderSessionId: string | undefined, signal?: AbortSignal) => Promise<unknown> | unknown;
  parentMessage?: (input: { text: string }, senderSessionId: string | undefined) => Promise<unknown> | unknown;
  subagentPoll?: (input: { session: string }, senderSessionId: string | undefined) => Promise<unknown> | unknown;
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
  const resolved = await createLanguageModel(providerId, modelId, provider);
  if (!resolved.ok) throw new Error(resolved.error.reason);
  const reasoningCatalog = findReasoningCatalogMatch(providerId, modelId, resolved.resolved);
  const reasoningVariants = listReasoningVariants(resolved.resolved, reasoningCatalog.model);
  let workspaceRoot = canonicalWorkspaceRoot(options.workspaceRoot ?? process.cwd());
  const { ToolRegistry } = await import('./tools/registry.js');
  let memoryIndex = new MemoryIndex(workspaceRoot);
  let activeInputModalities = modelInputModalities(providerId, modelId, resolved.resolved);
  let mcp: Awaited<ReturnType<(typeof import('./tools/mcp.js'))['connectMcpServers']>> | null = null;

  try {
    const [{ connectMcpServers }, { createToolCatalogue }] = await Promise.all([import('./tools/mcp.js'), import('./tools/catalog.js')]);
    mcp = await connectMcpServers(settings.mcpServers, {
      approveServer: options.approveMcpServer ?? (async () => false),
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
        ...(options.ownerMessageSend ? { ownerMessageSend: options.ownerMessageSend } : {}),
        ...(options.ownerInboxRead ? { ownerInboxRead: options.ownerInboxRead } : {}),
        ...(options.sessionMessage ? { sessionMessage: options.sessionMessage } : {}),
        ...(options.subagent ? { subagent: options.subagent } : {}),
        ...(options.parentMessage ? { parentMessage: options.parentMessage } : {}),
        ...(options.subagentPoll ? { subagentPoll: options.subagentPoll } : {}),
        ...(options.subagentStop ? { subagentStop: options.subagentStop } : {}),
      })) {
        registry.register(definition);
      }
      return registry;
    }
    let activeResolved = resolved.resolved;
    let activeCatalog = reasoningCatalog;
    let activeVariants = reasoningVariants;
    const runtime: AgentEnvironment = {
      model: resolved.model,
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
      reasoningDefault: settings.reasoning ?? 'auto',
      saveReasoningPreference: (variantId) => {
        const latest = loadSettings();
        latest.reasoning = variantId;
        saveSettings(latest);
        runtime.reasoningDefault = variantId;
      },
      showReasoningDefault: settings.showReasoning === true,
      approvalMode: settings.approvalMode,
      saveApprovalModePreference: (mode: ApprovalMode) => {
        const latest = loadSettings();
        latest.approvalMode = mode;
        saveSettings(latest);
        runtime.approvalMode = mode;
      },
      saveShowReasoningPreference: (visible) => {
        const latest = loadSettings();
        latest.showReasoning = visible;
        saveSettings(latest);
        runtime.showReasoningDefault = visible;
      },
      getReasoningProviderOptions: (variantId, visible) =>
        withReasoningVisibility(activeResolved, activeVariants.find((variant) => variant.id === variantId)?.providerOptions ?? {}, visible),
      registry: createRegistry(activeInputModalities),
      selectWorkspaceRoot: async (path) => {
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
        runtime.reasoningDefault = nextVariants.some((variant) => variant.id === (nextSettings.reasoning ?? 'auto'))
          ? (nextSettings.reasoning ?? 'auto')
          : 'auto';
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
