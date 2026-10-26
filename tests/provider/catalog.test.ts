import { closeSync, mkdirSync, mkdtempSync, openSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDataPath } from '../../src/paths.js';

/**
 * The catalog is stored as NDJSON with a byte-range index, and nothing the
 * catalog ships is dropped. Every test runs against a file on disk rather than
 * the network, written by the module's own writer so the format under test is
 * the real one.
 *
 * FIXTURE carries fields — pricing, limits, release dates — that a reader must
 * still be able to get.
 */
const FIXTURE = {
  providers: {
    openai: {
      id: 'openai',
      name: 'OpenAI',
      npm: '@ai-sdk/openai',
      api: 'https://api.openai.com/v1/chat/completions',
      env: ['OPENAI_API_KEY'],
      models: {
        'gpt-5': {
          id: 'gpt-5',
          tool_call: true,
          cost: { input: 2, output: 8, cache_read: 0.2 },
          limit: { context: 400000, output: 128000 },
          reasoning: true,
          structured_output: true,
          release_date: '2025-08-01',
        },
        'gpt-4o-mini': { id: 'gpt-4o-mini', tool_call: false, cost: { input: 1, output: 4 } },
        legacy: { id: 'legacy' },
      },
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
  dataDir = mkdtempSync(join(tmpdir(), 'ranite-catalog-'));
  process.env.RANITE_DATA_DIR = dataDir;
  mkdirSync(dataDir, { recursive: true });
});

afterEach(() => {
  delete process.env.RANITE_DATA_DIR;
});

/**
 * Loads the module fresh and writes a catalog through its own writer.
 *
 * Re-importing is required because the data directory is resolved once at module
 * load, so moving it afterwards would not move the paths.
 */
async function loadWithCatalog(
  payload: unknown = FIXTURE,
  fetchedAt = new Date().toISOString(),
): Promise<typeof import('../../src/provider/catalog.js')> {
  vi.resetModules();
  const catalog = await import('../../src/provider/catalog.js');
  catalog.writeCatalogSnapshot(payload, fetchedAt);
  catalog.resetCatalogCacheForTests();
  return catalog;
}

describe('reading a provider out of the file', () => {
  it('invalidates cached providers, misses and byte offsets when another process replaces the catalog', async () => {
    const catalog = await loadWithCatalog();
    const revision = catalog.getCatalogRevision();
    expect(catalog.getModel('openai', 'gpt-5')?.limit?.context).toBe(400000);
    expect(catalog.getProvider('new-provider')).toBeNull();
    const fetchedAt = (await catalog.getCatalogIndex()).fetchedAt;
    catalog.writeCatalogSnapshot(
      {
        'new-provider': { npm: '@ai-sdk/openai-compatible', models: { 'new-model': { reasoning: true } } },
        openai: {
          ...FIXTURE.providers.openai,
          models: { 'gpt-5': { ...FIXTURE.providers.openai.models['gpt-5'], limit: { context: 1048576 } } },
        },
      },
      fetchedAt,
    );
    expect(catalog.getModel('openai', 'gpt-5')?.limit?.context).toBe(1048576);
    expect(catalog.getModel('new-provider', 'new-model')?.reasoning).toBe(true);
    expect(catalog.listProviderIdsForModel('new-model')).toEqual(['new-provider']);
    expect(catalog.getCatalogRevision()).not.toBe(revision);
    expect((await catalog.getCatalogIndex()).fetchedAt).toBe(fetchedAt);
  });

  it('keeps every field the catalog shipped, not just the tool-call flag', async () => {
    const catalog = await loadWithCatalog();
    const model = catalog.getModel('openai', 'gpt-5');
    /* A slim projection threw these away and needed a refetch to get them
       back. On disk they cost nothing until something reads them. */
    expect(model).toMatchObject({
      id: 'gpt-5',
      tool_call: true,
      cost: { input: 2, output: 8, cache_read: 0.2 },
      limit: { context: 400000, output: 128000 },
      reasoning: true,
      structured_output: true,
      release_date: '2025-08-01',
    });
  });

  it('keeps the fields a provider is resolved from', async () => {
    const catalog = await loadWithCatalog();
    expect(catalog.getProvider('openai')).toMatchObject({
      id: 'openai',
      name: 'OpenAI',
      npm: '@ai-sdk/openai',
      api: 'https://api.openai.com/v1/chat/completions',
      env: ['OPENAI_API_KEY'],
    });
  });

  it('distinguishes a model that cannot call tools from one the catalog is silent about', async () => {
    const catalog = await loadWithCatalog();
    expect(catalog.getModel('openai', 'gpt-4o-mini')?.tool_call).toBe(false);
    expect(catalog.getModel('openai', 'legacy')?.tool_call).toBeUndefined();
  });

  it('reads a bare provider map as well as one wrapped in `providers`', async () => {
    const catalog = await loadWithCatalog();
    expect(catalog.listProviderIds().sort()).toEqual(['openai', 'solocal']);
  });

  it('reports no provider for an id the catalog does not carry', async () => {
    const catalog = await loadWithCatalog();
    expect(catalog.getProvider('does-not-exist')).toBeNull();
    expect(catalog.listProviderIds()).not.toContain('does-not-exist');
  });

  it('serves token prices straight from the line', async () => {
    const catalog = await loadWithCatalog();
    expect(catalog.getTokenPrice('openai', 'gpt-5')?.input).toBe(2);
    expect(catalog.getTokenPrice('openai', 'legacy')).toBeNull();
  });

  it('finds the right line for every provider when a provider has no models', async () => {
    const catalog = await loadWithCatalog();
    /* solocal sorts after openai, so its byte range is not the file start. A
       wrong offset reads openai's line, not an error. */
    expect(catalog.getProvider('solocal')).toMatchObject({ id: 'solocal', npm: '@ai-sdk/openai-compatible' });
    expect(catalog.getProvider('solocal')?.models).toEqual({});
  });

  it('reports unknown instead of crashing when a provider line is unreadable', async () => {
    const catalog = await loadWithCatalog();
    writeFileSync(`${getDataPath('catalog')}.ndjson`, 'not json at all\n');
    catalog.resetCatalogCacheForTests();
    expect(catalog.getProvider('openai')).toBeNull();
    expect(catalog.getModel('openai', 'gpt-5')).toBeNull();
  });

  it('refuses a line whose id does not match its index slot', async () => {
    const catalog = await loadWithCatalog();
    const index = catalog.writeCatalogSnapshot(FIXTURE, new Date().toISOString());
    const entry = index.entries['openai']!;
    const replacement = Buffer.from(JSON.stringify({ id: 'solocal', name: 'Wrong' }).padEnd(entry.length, ' '), 'utf8');
    const handle = openSync(`${getDataPath('catalog')}.ndjson`, 'r+');
    try {
      writeSync(handle, replacement, 0, replacement.length, entry.offset);
    } finally {
      closeSync(handle);
    }
    catalog.resetCatalogCacheForTests();
    expect(catalog.getProvider('openai')).toBeNull();
  });
});

describe('fetch limits', () => {
  it('rejects a chunked payload that exceeds the size limit without a content-length header', async () => {
    vi.resetModules();
    const catalog = await import('../../src/provider/catalog.js');
    catalog.resetCatalogCacheForTests();
    const chunk = new Uint8Array(1024 * 1024);
    let produced = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(chunk);
        if (++produced >= 21) controller.close();
      },
    });
    await expect(catalog.getCatalogIndex({ refresh: true, fetchImpl: async () => new Response(body, { status: 200 }) })).rejects.toThrow(
      /exceeded the 20 MiB limit/,
    );
  });

  it('rejects an oversized content-length before reading the body', async () => {
    vi.resetModules();
    const catalog = await import('../../src/provider/catalog.js');
    catalog.resetCatalogCacheForTests();
    const response = new Response('{}', { status: 200, headers: { 'content-length': String(21 * 1024 * 1024) } });
    await expect(catalog.getCatalogIndex({ refresh: true, fetchImpl: async () => response })).rejects.toThrow(/exceeded the 20 MiB limit/);
  });
});

describe('the index answers listing without reading a provider', () => {
  it('carries a model count and a tool-capable count for every provider', async () => {
    const catalog = await loadWithCatalog();
    expect(catalog.listProviderSummaries()).toEqual([
      expect.objectContaining({ id: 'openai', modelCount: 3, toolCapableCount: 1 }),
      expect.objectContaining({ id: 'solocal', modelCount: 0, toolCapableCount: 0 }),
    ]);
  });

  it('reports no catalog before one is on hand, rather than an empty one', async () => {
    vi.resetModules();
    const catalog = await import('../../src/provider/catalog.js');
    catalog.resetCatalogCacheForTests();
    /* A zero taken with no catalog reads as "this provider has nothing usable",
       which is a claim about the provider rather than about the cache. */
    expect(catalog.isCatalogLoaded()).toBe(false);
    expect(catalog.listProviderIds()).toEqual([]);
  });
});

describe('offline behaviour', () => {
  it('serves a month-old index when the refresh cannot reach the network', async () => {
    const monthAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const catalog = await loadWithCatalog(FIXTURE, monthAgo);
    const index = await catalog.getCatalogIndex({
      fetchImpl: () => Promise.reject(new Error('network is unreachable')),
    });
    /* A stale catalog still names providers and models, so ranite keeps working
       with an out-of-date list rather than refusing to start. */
    expect(index.fetchedAt).toBe(monthAgo);
    expect(catalog.getProvider('openai')).not.toBeNull();
  });

  it('refuses to invent a catalog when the network fails and nothing is cached', async () => {
    vi.resetModules();
    const catalog = await import('../../src/provider/catalog.js');
    catalog.resetCatalogCacheForTests();
    await expect(catalog.getCatalogIndex({ fetchImpl: () => Promise.reject(new Error('network is unreachable')) })).rejects.toThrow(
      /unavailable and nothing is cached/,
    );
  });

  it('serves the cache without a network call while it is fresh', async () => {
    const catalog = await loadWithCatalog();
    const index = await catalog.getCatalogIndex({
      fetchImpl: () => Promise.reject(new Error('a fresh cache must not be refreshed')),
    });
    expect(Object.keys(index.entries).sort()).toEqual(['openai', 'solocal']);
  });

  it('stores what models.dev sends, so a field that gains a reader is already there', async () => {
    const catalog = await loadWithCatalog();
    expect(catalog.catalogSizeOnDisk()).toBeGreaterThan(0);
  });
});
