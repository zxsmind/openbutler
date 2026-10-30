import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'openbutler-model-specs-'));
  process.env.OPENBUTLER_DATA_DIR = dataDir;
  mkdirSync(dataDir, { recursive: true });
});

afterEach(() => {
  delete process.env.OPENBUTLER_DATA_DIR;
});

async function loadModules() {
  vi.resetModules();
  const [settings, registry] = await Promise.all([import('../../src/settings.js'), import('../../src/provider/registry.js')]);
  return { settings, registry };
}

function writeSettings(yaml: string): void {
  writeFileSync(join(dataDir, 'settings.yaml'), yaml, 'utf8');
}

describe('payload and modelSpecs in settings', () => {
  it('parses and round-trips both fields', async () => {
    const { settings } = await loadModules();
    writeSettings(
      [
        'providers:',
        '  lab:',
        '    enabled: true',
        '    url: https://lab.example/v1',
        "    npm: '@ai-sdk/openai-compatible'",
        '    models: [swift]',
        '    payload:',
        '      reasoning_effort: low',
        '      chat_template_kwargs:',
        '        reasoning_effort: low',
        '    modelSpecs:',
        '      swift:',
        '        context: 131072',
        '        output: 8192',
        '        reasoning:',
        '          efforts: [low, high]',
        '',
      ].join('\n'),
    );

    const loaded = settings.loadSettings();
    expect(loaded.providers.lab.payload).toEqual({ reasoning_effort: 'low', chat_template_kwargs: { reasoning_effort: 'low' } });
    expect(loaded.providers.lab.modelSpecs?.swift).toEqual({
      context: 131072,
      output: 8192,
      reasoning: { efforts: ['low', 'high'] },
    });

    settings.saveSettings(loaded);
    const reloaded = settings.loadSettings();
    expect(reloaded.providers.lab.payload).toEqual({ reasoning_effort: 'low', chat_template_kwargs: { reasoning_effort: 'low' } });
    expect(reloaded.providers.lab.modelSpecs?.swift.context).toBe(131072);
  });

  it('rejects an unknown model spec key', async () => {
    const { settings } = await loadModules();
    writeSettings(['providers:', '  lab:', '    models: [swift]', '    modelSpecs:', '      swift:', '        bogus: 1', ''].join('\n'));
    expect(() => settings.loadSettings()).toThrow('modelSpecs.swift.bogus is not a model spec openbutler knows');
  });

  it('rejects a context that is not a positive whole number', async () => {
    const { settings } = await loadModules();
    writeSettings(
      ['providers:', '  lab:', '    models: [swift]', '    modelSpecs:', '      swift:', '        context: wide', ''].join('\n'),
    );
    expect(() => settings.loadSettings()).toThrow('modelSpecs.swift.context must be a positive whole number');
  });

  it('still rejects an unknown provider key', async () => {
    const { settings } = await loadModules();
    writeSettings(['providers:', '  lab:', '    mystery: 1', ''].join('\n'));
    expect(() => settings.loadSettings()).toThrow('providers.lab.mystery is not a setting openbutler knows');
  });
});

describe('settingsEffortVariants', () => {
  it('builds OpenAI-compatible effort variants in the provider namespace', async () => {
    const { registry } = await loadModules();
    const provider = { id: 'ukisai', npm: '@ai-sdk/openai-compatible' } as unknown as Parameters<typeof registry.settingsEffortVariants>[0];

    expect(registry.settingsEffortVariants(provider, ['low', 'high'])).toEqual([
      { id: 'low', label: 'Low', providerOptions: { ukisai: { reasoningEffort: 'low' } } },
      { id: 'high', label: 'High', providerOptions: { ukisai: { reasoningEffort: 'high' } } },
    ]);
    expect(registry.settingsEffortVariants(provider, ['low', 'default', 'low'])).toHaveLength(1);
    expect(registry.settingsEffortVariants(provider, [])).toEqual([]);
  });
});
