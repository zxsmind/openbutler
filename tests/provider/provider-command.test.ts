import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'openbutler-provider-cmd-'));
  process.env.OPENBUTLER_DATA_DIR = dataDir;
  mkdirSync(dataDir, { recursive: true });
});

afterEach(() => {
  delete process.env.OPENBUTLER_DATA_DIR;
});

/** Settings paths resolve at module load, so every import happens after the data dir moves. */
async function load() {
  vi.resetModules();
  const [settings, command] = await Promise.all([import('../../src/settings.js'), import('../../src/provider/provider-command.js')]);
  return { settings, command };
}

function readSettingsFile(): string {
  return readFileSync(join(dataDir, 'settings.yaml'), 'utf8');
}

function configFile(): string {
  return join(dataDir, 'config.yaml');
}

describe('isProviderCommand', () => {
  it('matches only the /provider word, not lookalikes', async () => {
    const { command } = await load();
    expect(command.isProviderCommand('/provider')).toBe(true);
    expect(command.isProviderCommand('  /provider list  ')).toBe(true);
    expect(command.isProviderCommand('/providerfoo')).toBe(false);
    expect(command.isProviderCommand('/providers')).toBe(false);
    expect(command.isProviderCommand('run /provider list')).toBe(false);
    expect(command.isProviderCommand('hello')).toBe(false);
  });
});

describe('/provider add', () => {
  it('adds a custom endpoint with the bundled default runtime and no secrets in settings', async () => {
    const { settings, command } = await load();
    const outcome = await command.runProviderCommand('/provider add ukisai --url https://ukisai.com/api/swift/v1 --model swift');

    expect(outcome.tone).toBe('info');
    expect(outcome.notice).toContain('Added ukisai');
    expect(outcome.notice).toContain('openbutler keys add ukisai');

    const stored = settings.loadSettings();
    expect(stored.providers.ukisai.enabled).toBe(true);
    expect(stored.providers.ukisai.url).toBe('https://ukisai.com/api/swift/v1');
    expect(stored.providers.ukisai.npm).toBe('@ai-sdk/openai-compatible');
    expect(stored.providers.ukisai.models).toEqual(['swift']);
    expect(stored.providers.ukisai.keys).toEqual([]);
    expect(stored.providerOrder).toContain('ukisai');
    expect(readSettingsFile()).toContain('ukisai');
    // saveSettings always rewrites the secret store; nothing of the provider may land in it.
    expect(readFileSync(configFile(), 'utf8')).not.toContain('ukisai');
  });

  it('merges repeated adds instead of replacing models', async () => {
    const { settings, command } = await load();
    await command.runProviderCommand('/provider add lab --url https://lab.example/v1 --model one');
    const second = await command.runProviderCommand('/provider add lab --url https://lab.example/v1 --npm @ai-sdk/openai --model two');

    expect(second.tone).toBe('info');
    expect(settings.loadSettings().providers.lab.models).toEqual(['one', 'two']);
    expect(settings.loadSettings().providers.lab.npm).toBe('@ai-sdk/openai');
  });

  it('keeps a quoted endpoint intact', async () => {
    const { settings, command } = await load();
    const outcome = await command.runProviderCommand('/provider add q --url "https://api.example.com/v1" --model swift');
    expect(outcome.tone).toBe('info');
    expect(settings.loadSettings().providers.q.url).toBe('https://api.example.com/v1');
  });

  it('stores payload and model specs from flags', async () => {
    const { settings, command } = await load();
    const outcome = await command.runProviderCommand(
      '/provider add lab --url https://lab.example/v1 --model swift --context 131072 --output 8192 --effort low,high --payload {"reasoning_effort":"low"}',
    );

    expect(outcome.tone).toBe('info');
    expect(outcome.notice).toContain('specs: context 131072, output 8192, efforts low/high');
    expect(outcome.notice).toContain('payload keys: reasoning_effort');

    const stored = settings.loadSettings();
    expect(stored.providers.lab.payload).toEqual({ reasoning_effort: 'low' });
    expect(stored.providers.lab.modelSpecs?.swift).toEqual({
      context: 131072,
      output: 8192,
      reasoning: { efforts: ['low', 'high'] },
    });
  });

  it('refuses payload that is not a JSON object', async () => {
    const { command } = await load();
    const badJson = await command.runProviderCommand('/provider add x --url https://api.example/v1 --model swift --payload {nope}');
    expect(badJson.tone).toBe('error');
    expect(badJson.notice).toContain('--payload must be valid JSON');

    const notObject = await command.runProviderCommand('/provider add x --url https://api.example/v1 --model swift --payload [1]');
    expect(notObject.tone).toBe('error');
    expect(notObject.notice).toContain('--payload must be a JSON object');
  });

  it('refuses an endpoint without a model, a bad id, or an unknown flag', async () => {
    const { settings, command } = await load();
    const noModel = await command.runProviderCommand('/provider add x --url https://api.example/v1');
    expect(noModel.tone).toBe('error');
    expect(noModel.notice).toContain('--model');

    const badId = await command.runProviderCommand('/provider add bad/id --url https://api.example/v1 --model swift');
    expect(badId.tone).toBe('error');

    const unknownFlag = await command.runProviderCommand('/provider add y --url https://api.example/v1 --model swift --token z');
    expect(unknownFlag.tone).toBe('error');
    expect(unknownFlag.notice).toContain('Unknown option: --token');

    expect(settings.loadSettings().providers.x).toBeUndefined();
    expect(settings.loadSettings().providers.bad).toBeUndefined();
    expect(settings.loadSettings().providers.y).toBeUndefined();
  });
});

describe('/provider list', () => {
  it('reports key counts and never key values', async () => {
    const { settings, command } = await load();
    const stored = settings.loadSettings();
    settings.upsertProvider(stored, 'secretive', {
      enabled: true,
      url: 'https://api.example/v1',
      npm: '@ai-sdk/openai-compatible',
      keys: ['sk-TESTKEY1234'],
      models: ['swift'],
    });
    settings.saveSettings(stored);

    const outcome = await command.runProviderCommand('/provider list');
    expect(outcome.tone).toBe('info');
    expect(outcome.notice).toContain('secretive');
    expect(outcome.notice).toContain('keys: 1');
    expect(outcome.notice).toContain('models: swift');
    expect(outcome.notice).not.toContain('TESTKEY1234');
    expect(outcome.notice).not.toContain('sk-');
  });

  it('says so when no provider exists yet', async () => {
    const { command } = await load();
    const outcome = await command.runProviderCommand('/provider list');
    expect(outcome.tone).toBe('warn');
    expect(outcome.notice).toContain('No providers yet');
  });
});

describe('/provider check', () => {
  it('builds a custom model without any live request', async () => {
    const { settings, command } = await load();
    const stored = settings.loadSettings();
    settings.upsertProvider(stored, 'ukisai', {
      enabled: true,
      url: 'https://ukisai.com/api/swift/v1',
      npm: '@ai-sdk/openai-compatible',
      keys: ['none'],
      models: ['swift'],
    });
    settings.saveSettings(stored);

    const outcome = await command.runProviderCommand('/provider check ukisai/swift');
    expect(outcome.tone).toBe('info');
    expect(outcome.notice).toContain('ukisai / swift');
    expect(outcome.notice).toContain('build ok');
    expect(outcome.notice).toContain('--ping');
  });

  it('reports an unknown provider and a provider without models clearly', async () => {
    const { settings, command } = await load();
    const unknown = await command.runProviderCommand('/provider check ghost/swift');
    expect(unknown.tone).toBe('error');
    expect(unknown.notice).toContain('not configured');

    const stored = settings.loadSettings();
    settings.upsertProvider(stored, 'empty', { enabled: true, url: 'https://api.example/v1', npm: '@ai-sdk/openai-compatible' });
    settings.saveSettings(stored);
    const noModel = await command.runProviderCommand('/provider check empty');
    expect(noModel.tone).toBe('error');
    expect(noModel.notice).toContain('no model');
  });
});

describe('/provider remove', () => {
  it('drops settings together with the credentials and says so', async () => {
    const { settings, command } = await load();
    const stored = settings.loadSettings();
    settings.upsertProvider(stored, 'keepme', {
      enabled: true,
      url: 'https://api.example/v1',
      npm: '@ai-sdk/openai-compatible',
      keys: ['sk-TESTKEY1234'],
      models: ['swift'],
    });
    settings.saveSettings(stored);

    const outcome = await command.runProviderCommand('/provider remove keepme');
    expect(outcome.tone).toBe('info');
    expect(outcome.notice).toContain('Removed keepme from settings.');
    expect(outcome.notice).toContain('cleared 1 key(s)');
    expect(settings.loadSettings().providers.keepme).toBeUndefined();
    expect(readFileSync(configFile(), 'utf8')).not.toContain('TESTKEY1234');
  });

  it('refuses an unknown id', async () => {
    const { command } = await load();
    const outcome = await command.runProviderCommand('/provider remove ghost');
    expect(outcome.tone).toBe('error');
    expect(outcome.notice).toContain('not configured');
  });
});

describe('/provider usage', () => {
  it('answers with usage for a bare invocation and for an unknown action', async () => {
    const { command } = await load();
    const bare = await command.runProviderCommand('/provider');
    expect(bare.tone).toBe('warn');
    expect(bare.notice).toContain('Usage:');

    const unknown = await command.runProviderCommand('/provider teleport');
    expect(unknown.tone).toBe('error');
    expect(unknown.notice).toContain('Unknown /provider action: teleport');
  });
});
