import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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

function writeConfig(yaml: string): void {
  writeFileSync(join(dataDir, 'config.yaml'), yaml, 'utf8');
}

function readSettingsFile(): string {
  return readFileSync(join(dataDir, 'settings.yaml'), 'utf8');
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

describe('team settings', () => {
  const teamYaml = [
    'team:',
    '  role: member',
    '  teamName: MyTeam',
    '  memberName: Murphy-Ranite',
    '  hubHost: 100.64.0.1',
    '  hubPort: 47821',
    '',
  ].join('\n');

  it('round-trips the non-secret team block', async () => {
    writeSettings(teamYaml);
    const settings = await loadSettingsModule();
    expect(settings.loadSettings().team).toEqual({
      role: 'member',
      teamName: 'MyTeam',
      memberName: 'Murphy-Ranite',
      hubHost: '100.64.0.1',
      hubPort: 47821,
    });
  });

  it('keeps the team ticket in config.yaml and never in settings.yaml', async () => {
    writeSettings(teamYaml);
    const settings = await loadSettingsModule();
    const loaded = settings.loadSettings();
    settings.saveSettings(loaded);
    settings.saveSecrets({ providers: {}, teamTicket: 'rt_secret_ticket' });
    expect(readFileSync(join(dataDir, 'config.yaml'), 'utf8')).toContain('teamTicket: rt_secret_ticket');
    expect(readSettingsFile()).not.toContain('rt_secret_ticket');
    expect(settings.loadSecrets().teamTicket).toBe('rt_secret_ticket');
  });

  it('carries the team ticket through a settings save so a save never logs the machine out', async () => {
    writeSettings(teamYaml);
    const settings = await loadSettingsModule();
    settings.saveSecrets({ providers: {}, teamTicket: 'rt_secret_ticket' });
    // A later, unrelated settings change rewrites both files.
    const loaded = settings.loadSettings();
    loaded.defaultModel = 'gpt-5';
    settings.saveSettings(loaded);
    expect(settings.loadSecrets().teamTicket).toBe('rt_secret_ticket');
    expect(readFileSync(join(dataDir, 'config.yaml'), 'utf8')).toContain('rt_secret_ticket');
  });

  it('rejects an invalid team block', async () => {
    writeSettings(['team:', '  role: leader', '  teamName: X', '  memberName: Y', '  hubHost: h', '  hubPort: 1', ''].join('\n'));
    const settings = await loadSettingsModule();
    expect(() => settings.loadSettings()).toThrow(/team.role must be hub or member/);
  });

  it('round-trips the hub fingerprint used to verify a rejoin', async () => {
    writeSettings([...teamYaml.trimEnd().split('\n'), '  hubFingerprint: A1B2:C3D4:E5F6', ''].join('\n'));
    const settings = await loadSettingsModule();
    const loaded = settings.loadSettings();
    expect(loaded.team?.hubFingerprint).toBe('A1B2:C3D4:E5F6');
    settings.saveSettings(loaded);
    expect(settings.loadSettings().team?.hubFingerprint).toBe('A1B2:C3D4:E5F6');
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

describe('approval timeout setting', () => {
  it('round-trips a configured timeout', async () => {
    writeSettings(['approvalTimeoutSeconds: 90', ''].join('\n'));
    const settings = await loadSettingsModule();
    expect(settings.loadSettings().approvalTimeoutSeconds).toBe(90);
    settings.saveSettings(settings.loadSettings());
    expect(settings.loadSettings().approvalTimeoutSeconds).toBe(90);
  });

  it('leaves the timeout unset by default', async () => {
    const settings = await loadSettingsModule();
    expect(settings.loadSettings().approvalTimeoutSeconds).toBeUndefined();
  });

  it('rejects a timeout outside the 5-600 second range', async () => {
    writeSettings(['approvalTimeoutSeconds: 2', ''].join('\n'));
    const settings = await loadSettingsModule();
    expect(() => settings.loadSettings()).toThrow(/approvalTimeoutSeconds must be a whole number of seconds between 5 and 600/);
  });

  it('rejects a non-integer timeout', async () => {
    writeSettings(['approvalTimeoutSeconds: 12.5', ''].join('\n'));
    const settings = await loadSettingsModule();
    expect(() => settings.loadSettings()).toThrow(/approvalTimeoutSeconds/);
  });
});

describe('auto-review model override', () => {
  it('round-trips a configured provider and model', async () => {
    writeSettings(['autoReviewProvider: vercel', 'autoReviewModel: alibaba/qwen3.8-omni-flash', ''].join('\n'));
    const settings = await loadSettingsModule();
    expect(settings.loadSettings().autoReviewProvider).toBe('vercel');
    expect(settings.loadSettings().autoReviewModel).toBe('alibaba/qwen3.8-omni-flash');
    settings.saveSettings(settings.loadSettings());
    expect(settings.loadSettings().autoReviewModel).toBe('alibaba/qwen3.8-omni-flash');
  });

  it('leaves the override unset by default', async () => {
    const settings = await loadSettingsModule();
    expect(settings.loadSettings().autoReviewProvider).toBeUndefined();
    expect(settings.loadSettings().autoReviewModel).toBeUndefined();
  });

  it('rejects a lone provider without a model', async () => {
    writeSettings(['autoReviewProvider: vercel', ''].join('\n'));
    const settings = await loadSettingsModule();
    expect(() => settings.loadSettings()).toThrow(/autoReviewProvider and autoReviewModel must both be/);
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

describe('settings/config split', () => {
  it('keeps key material out of settings.yaml on save', async () => {
    const settings = await loadSettingsModule();
    const store = settings.defaultSettings();
    store.providers.openai = { enabled: true, keys: ['sk-secret'] };
    store.providerOrder = ['openai'];
    settings.saveSettings(store);
    /* settings.yaml must be safe to show, share, or hand to the agent. */
    expect(readSettingsFile()).not.toContain('sk-secret');
    expect(readSettingsFile()).not.toContain('keys:');
    const loaded = settings.loadSettings();
    expect(loaded.providers.openai?.keys).toEqual(['sk-secret']);
  });

  it('merges keys from config.yaml into the loaded store', async () => {
    writeSettings(['providers:', '  openai:', '    enabled: true', 'defaultProvider: openai', ''].join('\n'));
    writeConfig(['providers:', '  openai:', '    keys: [sk-from-config]', ''].join('\n'));
    const settings = await loadSettingsModule();
    const loaded = settings.loadSettings();
    expect(loaded.providers.openai?.keys).toEqual(['sk-from-config']);
    expect(loaded.providers.openai?.enabled).toBe(true);
  });

  it('creates a config-only provider as enabled and reachable', async () => {
    writeSettings(['defaultProvider: ghost', ''].join('\n'));
    writeConfig(['providers:', '  ghost:', '    keys: [sk-ghost]', ''].join('\n'));
    const settings = await loadSettingsModule();
    const loaded = settings.loadSettings();
    expect(loaded.providers.ghost?.keys).toEqual(['sk-ghost']);
    expect(loaded.providers.ghost?.enabled).toBe(true);
    expect(loaded.providerOrder).toContain('ghost');
  });

  it('unites keys from both files instead of losing either side', async () => {
    writeSettings(['providers:', '  openai:', '    keys: [sk-old]', ''].join('\n'));
    writeConfig(['providers:', '  openai:', '    keys: [sk-new]', ''].join('\n'));
    const settings = await loadSettingsModule();
    expect(settings.loadSettings().providers.openai?.keys).toEqual(['sk-new', 'sk-old']);
  });

  it('migrates a pre-split file on save', async () => {
    writeSettings(['providers:', '  openai:', '    keys: [sk-legacy]', 'defaultProvider: openai', ''].join('\n'));
    const settings = await loadSettingsModule();
    /* Old files keep working before the first save. */
    expect(settings.loadSettings().providers.openai?.keys).toEqual(['sk-legacy']);
    settings.saveSettings(settings.loadSettings());
    /* After the save the keys live in config.yaml only. */
    expect(readSettingsFile()).not.toContain('sk-legacy');
    expect(settings.loadSettings().providers.openai?.keys).toEqual(['sk-legacy']);
    expect(readFileSync(join(dataDir, 'config.yaml'), 'utf8')).toContain('sk-legacy');
  });

  it('rejects unknown keys in config.yaml rather than ignoring them', async () => {
    writeConfig(['providers:', '  openai:', '    keys: [k]', '    modles: []', ''].join('\n'));
    const settings = await loadSettingsModule();
    expect(() => settings.loadSettings()).toThrow(/config providers\.openai\.modles is not a secret ranite knows/);
  });

  it('rejects an unknown top-level key in config.yaml', async () => {
    writeConfig(['apiKeys: []', ''].join('\n'));
    const settings = await loadSettingsModule();
    expect(() => settings.loadSettings()).toThrow(/apiKeys is not a secret ranite knows/);
  });

  it('exposes the config path next to the settings path', async () => {
    const settings = await loadSettingsModule();
    expect(settings.getConfigPath()).toBe(join(dataDir, 'config.yaml'));
  });
});

describe('background task parsing', () => {
  const taskYaml = (extra: string): string =>
    [
      'backgroundTasks:',
      '  - id: nightly',
      '    name: Nightly check',
      `    workspaceRoot: ${join(dataDir, 'work')}`,
      ...extra.split('\n'),
      '',
    ].join('\n');

  it('defaults a missing originSessionId to empty (no affinity)', async () => {
    writeSettings(taskYaml('    instruction: Check and report.\n    trigger: {adapter: manual, options: {}}'));
    const settings = await loadSettingsModule();
    expect(settings.loadSettings().backgroundTasks).toEqual([
      {
        id: 'nightly',
        name: 'Nightly check',
        enabled: true,
        workspaceRoot: join(dataDir, 'work'),
        originSessionId: '',
        instruction: 'Check and report.',
        trigger: { adapter: 'manual', options: {} },
      },
    ]);
  });

  it('keeps a provided originSessionId through a round trip', async () => {
    writeSettings(
      taskYaml('    originSessionId: session-abc\n    instruction: Check and report.\n    trigger: {adapter: manual, options: {}}'),
    );
    const settings = await loadSettingsModule();
    const loaded = settings.loadSettings();
    expect(loaded.backgroundTasks[0]?.originSessionId).toBe('session-abc');
    settings.saveSettings(loaded);
    expect(settings.loadSettings().backgroundTasks[0]?.originSessionId).toBe('session-abc');
  });

  it('rejects an unknown task key', async () => {
    writeSettings(taskYaml('    instruction: Check.\n    trigger: {adapter: manual, options: {}}\n    schedule: daily'));
    const settings = await loadSettingsModule();
    expect(() => settings.loadSettings()).toThrow(/background task schedule is not a supported setting/);
  });
});
