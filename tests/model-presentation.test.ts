import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadSettings, type SettingsStore } from '../src/settings.js';
import { getModel, getProvider } from '../src/provider/catalog.js';
import { modelPresentation, resolveModelName, resolveProviderName } from '../src/provider/model-presentation.js';

vi.mock('../src/settings.js', () => ({ loadSettings: vi.fn() }));
vi.mock('../src/provider/catalog.js', () => ({ getModel: vi.fn(), getProvider: vi.fn() }));

const settings = {
  providers: {
    inference: {
      enabled: true,
      keys: ['k'],
      modelSpecs: { 'qwen/qwen3-embedding-4b': { name: 'My Custom Embedder' } },
    },
    custom: { enabled: true, keys: ['k'], npm: '@ai-sdk/openai-compatible' },
  },
} as unknown as SettingsStore;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(loadSettings).mockReturnValue(settings);
  vi.mocked(getProvider).mockImplementation((providerId) =>
    providerId === 'inference' ? { id: providerId, name: 'Inference.net' } : null,
  );
  vi.mocked(getModel).mockImplementation((providerId, modelId) => {
    if (providerId === 'inference' && modelId === 'qwen/qwen3-embedding-4b') return { id: modelId, name: 'Qwen 3 Embedding 4B' };
    if (providerId === 'privatemode-ai' && modelId === 'qwen3-embedding-4b') return { id: modelId, name: 'Qwen3-Embedding 4B' };
    return null;
  });
});

describe('model presentation', () => {
  it('prefers the operator explicit name over the catalog name', () => {
    expect(resolveModelName('inference', 'qwen/qwen3-embedding-4b', settings)).toBe('My Custom Embedder');
  });

  it('falls back to this provider own catalog name', () => {
    expect(resolveModelName('privatemode-ai', 'qwen3-embedding-4b', settings)).toBe('Qwen3-Embedding 4B');
  });

  it('never guesses a name another provider recorded for the same id', () => {
    // `custom` has no catalog entry; the name under privatemode-ai must not leak in.
    expect(resolveModelName('custom', 'qwen3-embedding-4b', settings)).toBe('qwen3-embedding-4b');
  });

  it('returns the untouched id when nothing knows the model, slashes included', () => {
    expect(resolveModelName('custom', 'foo/bar-baz', settings)).toBe('foo/bar-baz');
  });

  it('stays usable with no catalog at all', () => {
    vi.mocked(getModel).mockReturnValue(null);
    vi.mocked(getProvider).mockReturnValue(null);
    expect(resolveModelName('custom', 'any/model', settings)).toBe('any/model');
    expect(resolveProviderName('custom')).toBe('custom');
  });

  it('reads settings only when the caller does not pass them', () => {
    expect(resolveModelName('inference', 'qwen/qwen3-embedding-4b')).toBe('My Custom Embedder');
    expect(loadSettings).toHaveBeenCalledTimes(1);
  });

  it('labels the provider with the catalog display name, else its id', () => {
    expect(resolveProviderName('inference')).toBe('Inference.net');
    expect(resolveProviderName('custom')).toBe('custom');
  });

  it('returns ids and names together for the API and the runtime', () => {
    expect(modelPresentation('inference', 'qwen/qwen3-embedding-4b', settings)).toEqual({
      providerId: 'inference',
      modelId: 'qwen/qwen3-embedding-4b',
      name: 'My Custom Embedder',
      providerName: 'Inference.net',
    });
    expect(modelPresentation('custom', 'x/y', settings)).toEqual({
      providerId: 'custom',
      modelId: 'x/y',
      name: 'x/y',
      providerName: 'custom',
    });
  });
});
