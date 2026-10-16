import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { addProviderKeys, classifyKeysTarget, describeProviderKeys, removeProviderKeys } from '../../src/cli/keys.js';

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'ranite-keys-'));
  process.env.RANITE_DATA_DIR = dataDir;
});

afterEach(() => {
  delete process.env.RANITE_DATA_DIR;
});

async function loadSettingsModule(): Promise<typeof import('../../src/settings.js')> {
  vi.resetModules();
  return import('../../src/settings.js');
}

function emptyStore(): import('../../src/settings.js').SettingsStore {
  return {
    providers: {},
    mcpServers: {},
    providerOrder: [],
    defaultProvider: '',
    defaultModel: '',
    approvalMode: 'workspace',
    backgroundTasks: [],
  };
}

describe('classifyKeysTarget', () => {
  it('accepts configured and catalog providers, redirects MCP ids', () => {
    const store = emptyStore();
    store.providers.custom = { enabled: true, keys: [] };
    store.mcpServers.bridge = { transport: 'http', url: 'https://example.com', headers: {} };
    const catalog = new Set(['openai']);
    expect(classifyKeysTarget(store, 'custom', catalog)).toEqual({ kind: 'provider' });
    expect(classifyKeysTarget(store, 'openai', catalog)).toEqual({ kind: 'provider' });
    expect(classifyKeysTarget(store, 'bridge', catalog)).toEqual({ kind: 'mcp-server', id: 'bridge' });
    expect(classifyKeysTarget(store, 'nope', catalog)).toEqual({ kind: 'unknown-provider', id: 'nope' });
  });
});

describe('addProviderKeys', () => {
  it('creates an enabled entry and skips duplicates', () => {
    const store = emptyStore();
    expect(addProviderKeys(store, 'openai', ['sk-a', 'sk-a', ' '])).toBe(1);
    expect(store.providers.openai).toEqual({ enabled: true, keys: ['sk-a'] });
    expect(store.providerOrder).toEqual(['openai']);
    expect(addProviderKeys(store, 'openai', ['sk-a'])).toBe(0);
    expect(addProviderKeys(store, 'openai', ['sk-b'])).toBe(1);
    expect(store.providers.openai?.keys).toEqual(['sk-a', 'sk-b']);
  });

  it('keeps a disabled provider disabled', () => {
    const store = emptyStore();
    store.providers.local = { enabled: false, keys: [] };
    addProviderKeys(store, 'local', ['k']);
    expect(store.providers.local?.enabled).toBe(false);
  });
});

describe('removeProviderKeys', () => {
  it('clears keys but keeps the entry', () => {
    const store = emptyStore();
    store.providers.openai = { enabled: true, keys: ['sk-a'] };
    expect(removeProviderKeys(store, 'openai')).toBe(true);
    expect(store.providers.openai).toEqual({ enabled: true, keys: [] });
    expect(removeProviderKeys(store, 'openai')).toBe(false);
    expect(removeProviderKeys(store, 'ghost')).toBe(false);
  });
});

describe('describeProviderKeys', () => {
  it('summarizes counts and tails in provider order', () => {
    const store = emptyStore();
    store.providers.b = { enabled: true, keys: ['sk-abcdef'] };
    store.providers.a = { enabled: false, keys: [] };
    store.providerOrder = ['a', 'b'];
    expect(describeProviderKeys(store)).toEqual([
      { id: 'a', enabled: false, keyCount: 0, tails: [] },
      { id: 'b', enabled: true, keyCount: 1, tails: ['cdef'] },
    ]);
  });
});

describe('keys round trip', () => {
  it('lands added keys in config.yaml, never in settings.yaml', async () => {
    const settings = await loadSettingsModule();
    const store = settings.defaultSettings();
    addProviderKeys(store, 'openai', ['sk-secret-value']);
    settings.saveSettings(store);
    const settingsFile = readFileSync(join(dataDir, 'settings.yaml'), 'utf8');
    expect(settingsFile).not.toContain('sk-secret-value');
    expect(settings.loadSettings().providers.openai?.keys).toEqual(['sk-secret-value']);
    const reloaded = settings.loadSettings();
    removeProviderKeys(reloaded, 'openai');
    settings.saveSettings(reloaded);
    expect(settings.loadSettings().providers.openai?.keys ?? []).toEqual([]);
  });

  it('accepts a provider id passed for a catalog provider with no entry yet', async () => {
    const settings = await loadSettingsModule();
    const store = settings.defaultSettings();
    expect(classifyKeysTarget(store, 'openai', new Set(['openai']))).toEqual({ kind: 'provider' });
    addProviderKeys(store, 'openai', ['k']);
    settings.saveSettings(store);
    expect(settings.loadSettings().providers.openai?.enabled).toBe(true);
  });
});
