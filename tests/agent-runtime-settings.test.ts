import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockLanguageModelV3 } from 'ai/test';
import { jsonSchema, tool } from 'ai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const calls = vi.hoisted(() => ({ build: vi.fn(), connectMcp: vi.fn(), reloadMcp: vi.fn(async () => false) }));
vi.mock('../src/memory-index.js', () => ({
  MemoryIndex: class {
    async close() {}
  },
  isMemoryEmbeddingModelPrepared: async () => true,
}));
vi.mock('../src/tools/catalog.js', () => ({ createToolCatalogue: () => [] }));
vi.mock('../src/tools/mcp.js', () => ({
  connectMcpServers: async (servers: unknown) => {
    calls.connectMcp(servers);
    return { tools: [], list: () => [], close: async () => {}, reload: calls.reloadMcp };
  },
}));

function response(reason: 'stop' | 'tool-calls') {
  return {
    stream: new ReadableStream({
      start(controller) {
        controller.enqueue({ type: 'stream-start', warnings: [] });
        if (reason === 'tool-calls')
          controller.enqueue({ type: 'tool-call', toolCallId: 'refresh', toolName: 'changeSettings', input: '{}' });
        controller.enqueue({
          type: 'finish',
          finishReason: { unified: reason, raw: reason },
          usage: {
            inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: 1, text: 1, reasoning: 0 },
          },
        });
        controller.close();
      },
    }),
  };
}

let directory: string;
let runtime: import('../src/agent-session.js').AgentEnvironment;
let settings: typeof import('../src/settings.js');
beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'openbutler-live-settings-'));
  vi.stubEnv('OPENBUTLER_DATA_DIR', directory);
  vi.resetModules();
  vi.clearAllMocks();
  // Recreate the partial mock with this test's catalog module and data directory.
  vi.doMock('../src/provider/registry.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../src/provider/registry.js')>();
    return {
      ...actual,
      createLanguageModel: async (id: string, modelId: string, state: import('../src/settings.js').ProviderState) => {
        calls.build(id, modelId, state);
        const result = actual.resolveProvider(id, state);
        if (!result.ok) return result;
        return { ok: true, model: new MockLanguageModelV3({ modelId, doStream: async () => response('stop') }), resolved: result.provider };
      },
    };
  });
  settings = await import('../src/settings.js');
  const catalog = await import('../src/provider/catalog.js');
  catalog.writeCatalogSnapshot(
    {
      vercel: {
        npm: '@ai-sdk/gateway',
        models: { mimo: { tool_call: true, limit: { context: 100_000 } }, minimax: { tool_call: true, limit: { context: 100_000 } } },
      },
    },
    new Date().toISOString(),
  );
  const store = settings.defaultSettings();
  store.providers.vercel = {
    enabled: true,
    keys: ['fixture-a'],
    models: ['mimo', 'minimax'],
    modelRouting: { mimo: { only: ['deepinfra'] } },
  };
  store.defaultProvider = 'vercel';
  store.defaultModel = 'mimo';
  settings.saveSettings(store);
  runtime = await (await import('../src/agent-runtime.js')).createAgentRuntime({ workspaceRoot: directory });
});
afterEach(async () => {
  await runtime?.close();
  vi.unstubAllEnvs();
});

describe('live runtime settings', () => {
  it('restores an old session model without rewriting the global default or waiting for a stale catalog refresh', async () => {
    const catalog = await import('../src/provider/catalog.js');
    catalog.writeCatalogSnapshot(
      {
        vercel: {
          npm: '@ai-sdk/gateway',
          models: {
            mimo: { limit: { context: 100_000 } },
            minimax: { limit: { context: 100_000 } },
          },
        },
      },
      new Date(0).toISOString(),
    );
    const savedFetch = globalThis.fetch;
    const fetcher = vi.fn<typeof fetch>(() => new Promise(() => {}));
    globalThis.fetch = fetcher;
    try {
      await runtime.restoreModel!('vercel', 'minimax');
      expect(runtime.modelId).toBe('minimax');
      expect(settings.loadSettings().defaultModel).toBe('mimo');
      expect(fetcher).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = savedFetch;
    }
  });

  it('borrows one daemon MCP manager across chat runtimes and refreshes each catalogue by revision', async () => {
    let revision = 0;
    const shared: import('../src/tools/mcp.js').McpConnectionManager = {
      get revision() {
        return revision;
      },
      tools: [],
      list: () => [],
      addServer: vi.fn(),
      connectServer: vi.fn(),
      disconnectServer: vi.fn(),
      removeServer: vi.fn(),
      reload: vi.fn(async () => false),
      close: vi.fn(async () => {}),
    };
    const { createAgentRuntime } = await import('../src/agent-runtime.js');
    const a = await createAgentRuntime({ workspaceRoot: directory, mcpManager: shared });
    const b = await createAgentRuntime({ workspaceRoot: directory, mcpManager: shared });
    let aClosed = false;
    try {
      expect(calls.connectMcp).toHaveBeenCalledOnce();
      await Promise.all([a.prepareForTurn!(), b.prepareForTurn!()]);
      const firstRegistry = b.registry;
      revision++;
      await b.reloadSettings!();
      expect(b.registry).not.toBe(firstRegistry);
      await a.close();
      aClosed = true;
      expect(shared.close).not.toHaveBeenCalled();
      await b.reloadSettings!(true);
    } finally {
      if (!aClosed) await a.close();
      await b.close();
      expect(shared.close).not.toHaveBeenCalled();
      await shared.close();
    }
  });

  it('opens an interactive chat before MCP connects and waits for its tools before the first model request', async () => {
    const store = settings.loadSettings();
    store.mcpServers.slow = { transport: 'stdio', command: 'fixture-mcp', args: [], env: {} };
    settings.saveSettings(store);
    const deferred = await (await import('../src/agent-runtime.js')).createAgentRuntime({ workspaceRoot: directory, deferMcp: true });
    const { AgentSessionController } = await import('../src/agent-session.js');
    const controller = new AgentSessionController(deferred);
    let release!: (changed: boolean) => void;
    const connected = new Promise<boolean>((resolve) => {
      release = resolve;
    });
    calls.reloadMcp.mockImplementationOnce(() => connected);
    const stream = vi.fn(async () => response('stop'));
    (deferred.model as MockLanguageModelV3).doStream = stream;
    try {
      expect(calls.connectMcp).toHaveBeenLastCalledWith({});
      expect(controller.getSnapshot().session.id).toBeTruthy();
      expect(controller.getSnapshot().session.entries).toEqual([]);
      await deferred.reloadSettings!(true);
      expect(calls.reloadMcp).not.toHaveBeenCalled();
      const turn = controller.sendMessage({ text: 'First message', images: [] }, { reasoningVariantId: 'default', showReasoning: false });
      await vi.waitFor(() => expect(calls.reloadMcp).toHaveBeenCalledWith(settings.loadSettings().mcpServers));
      expect(stream).not.toHaveBeenCalled();
      release(true);
      await turn;
      expect(stream).toHaveBeenCalledOnce();
      await deferred.prepareForTurn!();
      expect(calls.reloadMcp).toHaveBeenCalledOnce();
    } finally {
      release(true);
      await controller.close();
      await deferred.close();
    }
  });

  it('refreshes custom-model capabilities after an external catalog update without changing settings or restarting', async () => {
    const latest = settings.loadSettings();
    latest.providers.custom = {
      enabled: true,
      npm: '@ai-sdk/openai-compatible',
      url: 'http://localhost:1234/v1',
      keys: ['fixture-custom'],
      models: ['new-custom-model'],
      modelSpecs: { 'new-custom-model': { context: 100_000 } },
    };
    settings.saveSettings(latest);
    await runtime.selectModel('custom', 'new-custom-model');
    expect(runtime.contextWindowTokens).toBe(100_000);
    expect(runtime.reasoningVariants.map((variant) => variant.id)).toEqual(['default']);

    const catalog = await import('../src/provider/catalog.js');
    catalog.writeCatalogSnapshot(
      {
        mirror: {
          npm: '@ai-sdk/openai-compatible',
          models: {
            'new-custom-model': {
              reasoning: true,
              reasoning_options: [{ type: 'effort', values: ['low', 'high'] }],
              limit: { context: 1048576, output: 32768 },
            },
          },
        },
      },
      new Date().toISOString(),
    );
    const saved = settings.loadSettings();
    await runtime.reloadSettings!();
    expect(runtime.contextWindowTokens).toBe(1048576);
    expect(runtime.outputLimitTokens).toBe(32768);
    expect(runtime.reasoningVariants.map((variant) => variant.id)).toEqual(['default', 'low', 'high']);
    expect(runtime.reasoningMetadataSource).toBe('mirror');
    expect(settings.loadSettings()).toEqual(saved);
    await runtime.reloadSettings!();
    expect(calls.build).toHaveBeenCalledTimes(3);
  });

  it('restores another chat model without changing defaults or the first runtime', async () => {
    const other = await (
      await import('../src/agent-runtime.js')
    ).createAgentRuntime({ workspaceRoot: directory, initialModel: { providerId: 'vercel', modelId: 'minimax' } });
    try {
      expect(other.modelId).toBe('minimax');
      expect(runtime.modelId).toBe('mimo');
      expect(settings.loadSettings().defaultModel).toBe('mimo');
      await other.selectModel('vercel', 'minimax');
      await runtime.reloadSettings!();
      expect(other.modelId).toBe('minimax');
      expect(runtime.modelId).toBe('mimo');
    } finally {
      await other.close();
    }
  });
  it('refreshes keys and model routing without changing the selected model or rewriting files', async () => {
    const originalModel = runtime.model;
    const latest = settings.loadSettings();
    latest.providers.vercel!.keys = ['fixture-b'];
    latest.providers.vercel!.modelRouting = { mimo: { only: ['parasail'] } };
    latest.defaultModel = 'minimax';
    settings.saveSettings(latest);
    await runtime.reloadSettings!();
    expect(runtime.model).not.toBe(originalModel);
    expect(runtime.modelId).toBe('mimo');
    expect(calls.build.mock.lastCall?.[2].keys).toEqual(['fixture-b']);
    expect(runtime.getReasoningProviderOptions('default', false)).toEqual({ gateway: { only: ['parasail'] } });
    await runtime.reloadSettings!();
    expect(calls.build).toHaveBeenCalledTimes(2);
    expect(settings.loadSettings().defaultModel).toBe('minimax');
  });

  it('updates reviewer selection and preferences and can return to the main reviewer model', async () => {
    const latest = settings.loadSettings();
    latest.autoReviewProvider = 'vercel';
    latest.autoReviewModel = 'minimax';
    latest.showReasoning = false;
    latest.approvalMode = 'auto-review';
    settings.saveSettings(latest);
    await runtime.reloadSettings!();
    expect((runtime.reviewModel as MockLanguageModelV3).modelId).toBe('minimax');
    expect(runtime.showReasoningDefault).toBe(false);
    expect(runtime.approvalMode).toBe('auto-review');
    delete latest.autoReviewProvider;
    delete latest.autoReviewModel;
    settings.saveSettings(latest);
    await runtime.reloadSettings!();
    expect(runtime.reviewModel).toBeUndefined();
  });

  it('defers MCP reloads until the host explicitly allows tool changes', async () => {
    await runtime.reloadSettings!();
    expect(calls.reloadMcp).not.toHaveBeenCalled();
    await runtime.reloadSettings!(true);
    expect(calls.reloadMcp).toHaveBeenCalledWith({});
  });

  it('rejects invalid edits and removed credentials, then recovers on the next valid edit', async () => {
    const latest = settings.loadSettings();
    const originalModel = runtime.model;
    const lastValidSettings = readFileSync(settings.getSettingsPath(), 'utf8');
    writeFileSync(settings.getSettingsPath(), 'providers: [');
    await expect(runtime.reloadSettings!()).rejects.toThrow();
    expect(runtime.model).toBe(originalModel);
    // Restore the last valid on-disk file before saving a new revision.
    // Stale settings snapshots must not silently overwrite external edits.
    writeFileSync(settings.getSettingsPath(), lastValidSettings);
    latest.providers.vercel!.enabled = false;
    settings.saveSettings(latest);
    await expect(runtime.reloadSettings!()).rejects.toThrow(/disabled or not configured/);
    latest.providers.vercel!.enabled = true;
    latest.providers.vercel!.keys = ['fixture-c'];
    settings.saveSettings(latest);
    await runtime.reloadSettings!();
    expect(calls.build.mock.lastCall?.[2].keys).toEqual(['fixture-c']);
  });

  it('uses a changed credential on the next SDK step of the same running turn', async () => {
    (runtime.model as MockLanguageModelV3).doStream = async () => response('tool-calls');
    const { runAgent } = await import('../src/agent.js');
    await runAgent({
      model: runtime.model,
      system: 'Fixture',
      messages: [{ role: 'user', content: 'Refresh' }],
      getModel: async () => {
        await runtime.reloadSettings!();
        return runtime.model;
      },
      tools: {
        changeSettings: tool({
          inputSchema: jsonSchema({ type: 'object', properties: {} }),
          execute: async () => {
            const latest = settings.loadSettings();
            latest.providers.vercel!.keys = ['fixture-next-step'];
            settings.saveSettings(latest);
            return 'updated';
          },
        }),
      },
    });
    expect(calls.build).toHaveBeenCalledTimes(2);
    expect(calls.build.mock.lastCall?.[2].keys).toEqual(['fixture-next-step']);
  });

  it('uses changed approval policy for later calls in an already-created tool set', async () => {
    const { ToolRegistry } = await import('../src/tools/registry.js');
    const registry = new ToolRegistry();
    const execute = vi.fn(async () => 'ok');
    const approve = vi.fn(async () => true);
    registry.register({
      providerId: 'host',
      name: 'change',
      description: 'Fixture',
      inputSchema: { type: 'object', properties: {} },
      effect: { change: 'modify', data: 'local', network: 'none', reversible: 'full', outbound: 'none' },
      execute,
    });
    let mode: import('../src/settings.js').ApprovalMode = 'full-access';
    const built = await registry.createModelTools({ approve, approvalMode: () => mode, onResult: () => {} });
    await built.tools.change!.execute!({}, { toolCallId: 'first', messages: [] });
    expect(approve).not.toHaveBeenCalled();
    mode = 'workspace';
    await built.tools.change!.execute!({}, { toolCallId: 'second', messages: [] });
    expect(approve).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledTimes(2);
  });
});
