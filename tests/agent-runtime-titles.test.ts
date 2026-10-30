import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockLanguageModelV3 } from 'ai/test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/memory-index.js', () => ({
  MemoryIndex: class {
    async close() {}
  },
  isMemoryEmbeddingModelPrepared: async () => true,
}));
vi.mock('../src/tools/catalog.js', () => ({ createToolCatalogue: () => [] }));
vi.mock('../src/tools/mcp.js', () => ({
  connectMcpServers: async () => ({
    tools: [],
    list: () => [],
    close: async () => {},
    reload: async () => false,
  }),
}));

function response() {
  return {
    stream: new ReadableStream({
      start(controller) {
        controller.enqueue({ type: 'stream-start', warnings: [] });
        controller.enqueue({
          type: 'finish',
          finishReason: { unified: 'stop', raw: 'stop' },
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
  directory = mkdtempSync(join(tmpdir(), 'openbutler-titles-'));
  vi.stubEnv('OPENBUTLER_DATA_DIR', directory);
  vi.resetModules();
  vi.doMock('../src/provider/registry.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../src/provider/registry.js')>();
    return {
      ...actual,
      createLanguageModel: async (id: string, modelId: string, state: import('../src/settings.js').ProviderState) => {
        const result = actual.resolveProvider(id, state);
        if (!result.ok) return result;
        return {
          ok: true,
          model: new MockLanguageModelV3({ modelId, doStream: async () => response() }),
          resolved: result.provider,
        };
      },
    };
  });
  settings = await import('../src/settings.js');
  const catalog = await import('../src/provider/catalog.js');
  catalog.writeCatalogSnapshot(
    {
      vercel: {
        npm: '@ai-sdk/gateway',
        models: { mimo: { tool_call: true, limit: { context: 100_000 } } },
      },
    },
    new Date().toISOString(),
  );
  const store = settings.defaultSettings();
  store.providers.vercel = { enabled: true, keys: ['fixture-a'], models: ['mimo'] };
  store.defaultProvider = 'vercel';
  store.defaultModel = 'mimo';
  settings.saveSettings(store);
  runtime = await (await import('../src/agent-runtime.js')).createAgentRuntime({ workspaceRoot: directory });
});
afterEach(async () => {
  await runtime?.close();
  vi.unstubAllEnvs();
});

describe('runtime reasoningTitles flag', () => {
  it('is a boolean at creation, derived from the provider adapter', async () => {
    // The gateway adapter carries no summary titles: the flag must be false,
    // never undefined - an unset flag silently disables the web headline.
    expect(runtime.reasoningTitles).toBe(false);
  });

  it('follows the adapter on every model switch', async () => {
    const latest = settings.loadSettings();
    latest.providers.custom = {
      enabled: true,
      npm: '@ai-sdk/anthropic',
      url: 'https://api.anthropic.test/v1',
      keys: ['fixture-anthropic'],
      models: ['claude-x'],
      modelSpecs: { 'claude-x': { context: 100_000 } },
    };
    settings.saveSettings(latest);
    await runtime.selectModel('custom', 'claude-x');
    expect(runtime.reasoningTitles).toBe(true);
    await runtime.selectModel('vercel', 'mimo');
    expect(runtime.reasoningTitles).toBe(false);
  });
});
