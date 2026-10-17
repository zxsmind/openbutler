import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const CATALOG = {
  providers: {
    openai: {
      id: 'openai',
      name: 'OpenAI',
      npm: '@ai-sdk/openai',
      api: 'https://api.openai.com/v1/chat/completions',
      env: ['OPENAI_API_KEY'],
      models: {
        'gpt-5': { tool_call: true },
        'gpt-4o-mini': { tool_call: false },
        'gpt-silent': {},
      },
    },
    cloudaccount: {
      id: 'cloudaccount',
      name: 'Cloud Account',
      npm: '@ai-sdk/google-vertex',
      env: ['CLOUD_ACCOUNT_PROJECT', 'CLOUD_APPLICATION_CREDENTIALS'],
      models: { 'big-model': { tool_call: true } },
    },
    solocal: {
      id: 'solocal',
      name: 'So Local',
      npm: '@ai-sdk/openai-compatible',
      api: 'http://localhost:1234/v1',
      models: {},
    },
  },
};

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'ranite-provider-'));
  process.env.RANITE_DATA_DIR = dataDir;
  mkdirSync(dataDir, { recursive: true });
  delete process.env.OPENAI_API_KEY;
  delete process.env.RANITE_API_KEY;
});

afterEach(() => {
  delete process.env.RANITE_DATA_DIR;
  delete process.env.OPENAI_API_KEY;
  delete process.env.RANITE_API_KEY;
});

/**
 * Writes the catalog through the module's own writer, then loads fresh.
 *
 * Re-importing is required because the data directory is resolved once at module
 * load. The registry holds no module state of its own.
 */
async function load(): Promise<{
  catalog: typeof import('../../src/provider/catalog.js');
  registry: typeof import('../../src/provider/registry.js');
}> {
  vi.resetModules();
  const catalog = await import('../../src/provider/catalog.js');
  catalog.writeCatalogSnapshot(CATALOG, new Date().toISOString());
  catalog.resetCatalogCacheForTests();
  const registry = await import('../../src/provider/registry.js');
  return { catalog, registry };
}

describe('tool-call mode', () => {
  it('reads the catalog flag', async () => {
    const { registry } = await load();
    expect(registry.toolCallMode('openai', 'gpt-5')).toBe('native');
    expect(registry.toolCallMode('openai', 'gpt-4o-mini')).toBe('unsupported');
  });

  it('reports unknown rather than guessing when the catalog says nothing', async () => {
    const { registry } = await load();
    /* Unknown must not be treated as usable: a model the catalog is silent about
       would otherwise be offered and then never call a tool. */
    expect(registry.toolCallMode('openai', 'gpt-silent')).toBe('unknown');
    expect(registry.canUseTools('openai', 'gpt-silent')).toBe(false);
    expect(registry.canUseTools('openai', 'gpt-5')).toBe(true);
  });

  it('takes an operator-declared endpoint at its word, because nothing can check it', async () => {
    const { registry } = await load();
    const override = { npm: '@ai-sdk/openai-compatible' };
    /* A local endpoint is not in the catalog, so its capabilities cannot be
       verified. The operator declared the runtime, which is the only signal
       available, and it is trusted. */
    expect(registry.toolCallMode('my-local', 'anything-at-all', override)).toBe('native');
    /* With no declared runtime there is nothing to stand on, so it stays
       unknown rather than becoming a silent yes. */
    expect(registry.toolCallMode('my-local', 'anything-at-all')).toBe('unknown');
  });
});

describe('resolving a provider', () => {
  it('takes the runtime package and endpoint from the catalog', async () => {
    const { registry } = await load();
    process.env.OPENAI_API_KEY = 'sk-from-env';
    const result = registry.resolveProvider('openai');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.provider.npm).toBe('@ai-sdk/openai');
    expect(result.provider.baseURL).toBe('https://api.openai.com/v1/chat/completions');
    expect(result.provider.custom).toBe(false);
    expect(result.provider.apiKey).toEqual({ key: 'sk-from-env', source: 'env', envName: 'OPENAI_API_KEY' });
  });

  it('explains what to do for a catalog-unknown id with no declared runtime', async () => {
    const { registry } = await load();
    process.env.RANITE_API_KEY = 'k';
    const result = registry.resolveProvider('nowhere');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.reason).toContain('RANITE_NPM');
  });

  it('accepts a runtime package ranite does not bundle, to install on first use', async () => {
    const { registry } = await load();
    /* An unknown package is no longer refused here: the model builder installs
       it from the catalog's package name the first time it is used (install.ts). */
    const result = registry.resolveProvider('exotic', { npm: '@some/unknown-sdk', keys: ['k'] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.provider.npm).toBe('@some/unknown-sdk');
    expect(result.provider.custom).toBe(true);
  });

  it('reports a provider with no credential instead of building a broken model', async () => {
    const { registry } = await load();
    const result = registry.resolveProvider('openai');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.reason).toContain('OPENAI_API_KEY');
  });

  it('accepts a provider that authenticates with options and no key', async () => {
    const { registry } = await load();
    /* A credential chain or a service account needs no key: the operator names
       what the package needs, and that declaration is the credential. */
    const result = registry.resolveProvider('cloudaccount', { options: { project: 'p', location: 'us' } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.provider.apiKey).toBeNull();
    expect(result.provider.options).toEqual({ project: 'p', location: 'us' });
  });

  it('decides per package whether a found key is actually handed over', async () => {
    const { registry } = await load();
    /* A settings key is an explicit choice and always travels, even to a package
       that reads its own environment. */
    expect(registry.passesKeyToPackage('@ai-sdk/google-vertex', { key: 'k', source: 'settings' })).toBe(true);
    expect(registry.passesKeyToPackage('@ai-sdk/google-vertex', { key: 'k', source: 'env', envName: 'RANITE_API_KEY' })).toBe(true);
    /* A catalog-named variable is not a choice Ranite made. When the package
       cannot be inspected — not installed yet — the long-standing behaviour of
       passing the key is kept, because silently withholding it would break the
       OpenAI-compatible gateways that need it. */
    expect(
      registry.passesKeyToPackage('@ai-sdk/definitely-not-installed', { key: 'k', source: 'env', envName: 'CLOUD_ACCOUNT_PROJECT' }),
    ).toBe(true);
  });

  it('treats a set catalog variable as a credential for gating', async () => {
    const { registry } = await load();
    expect(registry.providerIsConfigured('openai', undefined)).toBe(false);
    process.env.OPENAI_API_KEY = 'sk-from-env';
    try {
      /* The key lives in the environment and nowhere Ranite wrote down, and the
         provider is still configured. */
      expect(registry.providerIsConfigured('openai', undefined)).toBe(true);
    } finally {
      delete process.env.OPENAI_API_KEY;
    }
    expect(registry.providerIsConfigured('openai', { enabled: true, keys: [], options: { project: 'p' } })).toBe(true);
  });

  it('lets a configured key win over the environment', async () => {
    const { registry } = await load();
    process.env.OPENAI_API_KEY = 'sk-from-env';
    const result = registry.resolveProvider('openai', { keys: ['sk-from-settings'] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.provider.apiKey).toEqual({ key: 'sk-from-settings', source: 'settings' });
  });

  it('lets a base URL override replace the catalog endpoint', async () => {
    const { registry } = await load();
    const result = registry.resolveProvider('openai', { keys: ['k'], url: 'https://proxy.internal/v1' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.provider.baseURL).toBe('https://proxy.internal/v1');
  });

  it('exposes every settings key in order for rotation', async () => {
    const { registry } = await load();
    const result = registry.resolveProvider('openai', { keys: ['sk-one', '', 'sk-two'] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    /* Blank entries are dropped; the primary key is the first of the rest. */
    expect(result.provider.apiKey).toEqual({ key: 'sk-one', source: 'settings' });
    expect(result.provider.apiKeys).toEqual([
      { key: 'sk-one', source: 'settings' },
      { key: 'sk-two', source: 'settings' },
    ]);
  });

  it('leaves apiKeys empty when the credential comes from the environment', async () => {
    const { registry } = await load();
    process.env.OPENAI_API_KEY = 'sk-from-env';
    const result = registry.resolveProvider('openai');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.provider.apiKeys).toEqual([]);
  });
});

describe('listing models ranite will offer', () => {
  it('offers only models the catalog says can call tools', async () => {
    const { registry } = await load();
    const models = registry.listToolCapableModels(['openai']).map((entry) => entry.model);
    expect(models).toEqual(['gpt-5']);
  });

  it('offers every tool-capable model, because a run uses one model and not a list', async () => {
    const { registry } = await load();
    const models = registry.listToolCapableModels(['openai']).map((entry) => entry.model);
    /* There is no whitelist to narrow this with any more; the catalog's own
       tool-call flag is the only filter, which is the point. */
    expect(models).toEqual(['gpt-5']);
  });

  it('offers nothing for a provider the catalog does not carry', async () => {
    const { registry } = await load();
    /* Its one model is named in settings, not enumerated here, so there is no
       list to return and pretending otherwise would invent models. */
    expect(registry.listToolCapableModels(['my-local'])).toEqual([]);
  });
});

describe('reasoning visibility preserves the selected mode', () => {
  it('does not select adaptive thinking when showing Anthropic reasoning', async () => {
    const { registry } = await load();
    const resolved = registry.resolveProvider('anthropic', { npm: '@ai-sdk/anthropic', keys: ['fixture'] });
    if (!resolved.ok) throw new Error(resolved.error.reason);
    const automatic = registry.withReasoningVisibility(resolved.provider, {}, true);
    expect(automatic.anthropic?.thinking).toBeUndefined();
    expect(automatic.anthropic?.sendReasoning).toBe(true);
    const selected = { anthropic: { thinking: { type: 'disabled' } } };
    expect(registry.withReasoningVisibility(resolved.provider, selected, true)).toEqual(selected);
  });

  it('does not enable or increase OpenRouter reasoning when showing its output', async () => {
    const { registry } = await load();
    const resolved = registry.resolveProvider('openrouter', { npm: '@openrouter/ai-sdk-provider', keys: ['fixture'] });
    if (!resolved.ok) throw new Error(resolved.error.reason);
    expect(registry.withReasoningVisibility(resolved.provider, {}, true)).toEqual({ openrouter: { reasoning: { exclude: false } } });
    const selected = { openrouter: { reasoning: { enabled: false, effort: 'none' } } };
    expect(registry.withReasoningVisibility(resolved.provider, selected, true)).toEqual({
      openrouter: { reasoning: { enabled: false, effort: 'none', exclude: false } },
    });
    expect(selected.openrouter.reasoning).toEqual({ enabled: false, effort: 'none' });
  });
});

describe('on-demand provider packages', () => {
  it('reports no entry point for a package that is not installed', async () => {
    vi.resetModules();
    const install = await import('../../src/provider/install.js');
    /* Nothing is installed in the fresh data directory, so the entry is null
       rather than an error — the caller decides to install. */
    expect(install.installedEntry('@ai-sdk/definitely-not-installed')).toBeNull();
  });
});
