import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'ranite-settings-'));
  process.env.RANITE_DATA_DIR = dataDir;
  mkdirSync(dataDir, { recursive: true });
});

afterEach(() => {
  delete process.env.RANITE_DATA_DIR;
});

/**
 * The settings path is computed once at module load, so the module has to be
 * re-imported after `RANITE_DATA_DIR` moves; `resetModules` is what makes that
 * actually a new instance rather than the cached one.
 */
async function loadSettingsModule(): Promise<typeof import('../src/settings.js')> {
  vi.resetModules();
  return import('../src/settings.js');
}

async function loadConfigEdit(): Promise<typeof import('../src/cli/config-edit.js')> {
  vi.resetModules();
  return import('../src/cli/config-edit.js');
}

function writeSettings(yaml: string): void {
  writeFileSync(join(dataDir, 'settings.yaml'), yaml, 'utf8');
}

describe('settings round trip', () => {
  it('defaults to nothing configured when there is no file', async () => {
    const settings = await loadSettingsModule();
    expect(settings.loadSettings()).toEqual(settings.defaultSettings());
  });

  it('preserves providers, order, and the default model', async () => {
    writeSettings(
      [
        'providers:',
        '  openai:',
        '    enabled: true',
        '    keys: [sk-a]',
        '  my-local:',
        '    enabled: true',
        '    keys: [local]',
        "    npm: '@ai-sdk/openai-compatible'",
        '    url: http://127.0.0.1:11434/v1',
        'providerOrder: [openai, my-local]',
        'defaultProvider: openai',
        'defaultModel: gpt-5',
        '',
      ].join('\n'),
    );
    const settings = await loadSettingsModule();
    const loaded = settings.loadSettings();
    expect(Object.keys(loaded.providers).sort()).toEqual(['my-local', 'openai']);
    expect(loaded.providerOrder).toEqual(['openai', 'my-local']);
    expect(loaded.defaultProvider).toBe('openai');
    expect(loaded.defaultModel).toBe('gpt-5');
    expect(loaded.providers['my-local']?.url).toBe('http://127.0.0.1:11434/v1');
    expect(loaded.providers['my-local']?.npm).toBe('@ai-sdk/openai-compatible');
  });

  it('preserves provider-specific model IDs across a settings round trip', async () => {
    writeSettings(['providers:', '  openai:', '    keys: [sk-a]', '    models: [gpt-5, gpt-5.1]', ''].join('\n'));
    const settings = await loadSettingsModule();
    expect(settings.loadSettings().providers.openai?.models).toEqual(['gpt-5', 'gpt-5.1']);
    settings.saveSettings(settings.loadSettings());
    expect(settings.loadSettings().providers.openai?.models).toEqual(['gpt-5', 'gpt-5.1']);
  });

  it('defaults a provider to enabled when the key is absent', async () => {
    writeSettings(['providers:', '  openai:', '    keys: [sk-a]', ''].join('\n'));
    const settings = await loadSettingsModule();
    expect(settings.loadSettings().providers.openai?.enabled).toBe(true);
  });

  it('fills in a provider missing from providerOrder', async () => {
    writeSettings(['providers:', '  a: {keys: [k]}', '  b: {keys: [k]}', 'providerOrder: [a]', ''].join('\n'));
    const settings = await loadSettingsModule();
    /* Order is a convenience; a provider that is configured but unlisted still
       has to be reachable, or it looks configured and is never used. */
    expect(settings.loadSettings().providerOrder).toEqual(['a', 'b']);
  });
});

describe('auto-review timeout setting', () => {
  it('round-trips a configured timeout', async () => {
    writeSettings(['approvalMode: auto-review', 'autoReviewTimeoutSeconds: 45', ''].join('\n'));
    const settings = await loadSettingsModule();
    expect(settings.loadSettings().autoReviewTimeoutSeconds).toBe(45);
    settings.saveSettings(settings.loadSettings());
    expect(settings.loadSettings().autoReviewTimeoutSeconds).toBe(45);
  });

  it('rejects a timeout outside the 5-600 second range', async () => {
    writeSettings(['autoReviewTimeoutSeconds: 2', ''].join('\n'));
    const settings = await loadSettingsModule();
    expect(() => settings.loadSettings()).toThrow(/autoReviewTimeoutSeconds must be a whole number of seconds between 5 and 600/);
  });

  it('rejects a non-integer timeout', async () => {
    writeSettings(['autoReviewTimeoutSeconds: 12.5', ''].join('\n'));
    const settings = await loadSettingsModule();
    expect(() => settings.loadSettings()).toThrow(/autoReviewTimeoutSeconds/);
  });
});

describe('the settings schema is closed', () => {
  it('rejects an unknown top-level key rather than ignoring it', async () => {
    writeSettings(['provders:', '  openai: {keys: [k]}', ''].join('\n'));
    const settings = await loadSettingsModule();
    /* A typo that silently fell back to a default surfaces days later. */
    expect(() => settings.loadSettings()).toThrow(/provders is not a setting ranite knows/);
  });

  it('rejects an unknown provider key', async () => {
    writeSettings(['providers:', '  openai:', '    keys: [k]', '    modles: []', ''].join('\n'));
    const settings = await loadSettingsModule();
    expect(() => settings.loadSettings()).toThrow(/providers\.openai\.modles is not a setting ranite knows/);
  });

  it('rejects a keys list that is not a list of strings', async () => {
    writeSettings(['providers:', '  openai:', '    keys:', '      - 42', ''].join('\n'));
    const settings = await loadSettingsModule();
    expect(() => settings.loadSettings()).toThrow(/keys must be a list of strings/);
  });

  it('names the known keys when it rejects, so the fix is obvious', async () => {
    writeSettings(['providers:', '  openai:', '    keys: [k]', '    modles: []', ''].join('\n'));
    const settings = await loadSettingsModule();
    expect(() => settings.loadSettings()).toThrow(/known: enabled, keys, models, url, npm/);
  });
});

describe('writing settings', () => {
  it('orders providers by providerOrder on the way out', async () => {
    const settings = await loadSettingsModule();
    const store = settings.defaultSettings();
    store.providers.b = { enabled: true, keys: ['kb'] };
    store.providers.a = { enabled: true, keys: ['ka'] };
    store.providerOrder = ['a', 'b'];
    settings.saveSettings(store);
    expect(settings.loadSettings().providerOrder).toEqual(['a', 'b']);
  });

  it('keeps each selected model under its provider when the default changes', async () => {
    const settings = await loadSettingsModule();
    const { setDefaultModel } = await loadConfigEdit();
    const store = settings.defaultSettings();
    store.providers.beta = { enabled: true, keys: ['key'], npm: '@ai-sdk/openai-compatible', url: 'http://localhost/v1' };
    store.providers.alpha = { enabled: true, keys: ['key'], npm: '@ai-sdk/openai-compatible', url: 'http://localhost/v1' };
    store.providerOrder = ['beta', 'alpha'];
    expect(setDefaultModel(store, 'beta', 'model-one')).toBe(true);
    expect(setDefaultModel(store, 'alpha', 'model-two')).toBe(true);
    expect(store.providers.beta?.models).toEqual(['model-one']);
    expect(store.providers.alpha?.models).toEqual(['model-two']);
    settings.saveSettings(store);
    const saved = settings.loadSettings();
    expect(saved.providers.beta?.models).toEqual(['model-one']);
    expect(saved.providers.alpha?.models).toEqual(['model-two']);
  });

  it('clears the default model when its provider is removed', async () => {
    const settings = await loadSettingsModule();
    const store = settings.defaultSettings();
    store.providers.a = { enabled: true, keys: ['ka'] };
    store.providerOrder = ['a'];
    store.defaultProvider = 'a';
    store.defaultModel = 'gpt-5';
    settings.saveSettings(store);

    const { removeProvider } = await loadConfigEdit();
    const reloaded = settings.loadSettings();
    expect(removeProvider(reloaded, 'a')).toBe(true);
    /* A default pointing at a removed provider is a run that fails on startup. */
    expect(reloaded.defaultProvider).toBe('');
    expect(reloaded.defaultModel).toBe('');
  });

  it('keeps the default provider and model as one pair', async () => {
    const settings = await loadSettingsModule();
    const { setDefaultModel } = await loadConfigEdit();
    const store = settings.defaultSettings();
    store.providers.a = { enabled: true, keys: ['ka'] };
    store.providers.b = { enabled: true, keys: ['kb'] };
    store.providerOrder = ['a', 'b'];

    expect(setDefaultModel(store, 'a', 'gpt-5')).toBe(true);
    expect(setDefaultModel(store, 'b', 'claude-opus-4-5')).toBe(true);
    /* Setting one half without the other is a run that points at nothing. */
    expect(store.defaultProvider).toBe('b');
    expect(store.defaultModel).toBe('claude-opus-4-5');
    expect(setDefaultModel(store, 'nope', 'x')).toBe(false);
  });
});
