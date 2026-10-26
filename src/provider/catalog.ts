import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { getDataPath } from '../paths.js';

/**
 * The provider/model catalog, fetched from models.dev.
 *
 * Ranite never lists a provider in code. The catalog is the list: it carries,
 * per provider, the display name, the API endpoint, the environment variables
 * that hold the key, the npm package that speaks it, and every model's
 * capabilities. A provider ranite has never heard of works the moment it is in
 * the catalog and its key is set.
 *
 * ## How it is stored
 *
 * One NDJSON file, one line per provider, plus a small index that maps a
 * provider id to its byte range. Nothing is thrown away: the file holds exactly
 * what models.dev ships, so a field that gains a reader later is already there.
 *
 * What is held in memory is a *decision*, not a copy. A run reads the index
 * once per disk revision and then only the provider lines it is asked about, which is why
 * the catalog costs about a megabyte on a warm run instead of the 24 MiB that
 * parsing the whole 5 MiB payload cost. `JSON.parse` cannot do this, because a
 * JSON document has no addressable interior; NDJSON does, which is the entire
 * reason for the format.
 */

export type CatalogReasoningOption =
  | { readonly type: 'toggle' }
  | { readonly type: 'effort'; readonly values: readonly (string | null)[] }
  | { readonly type: 'budget_tokens'; readonly min?: number; readonly max?: number };

export interface CatalogModel {
  readonly id: string;
  readonly name?: string;
  readonly reasoning?: boolean;
  readonly reasoning_options?: readonly CatalogReasoningOption[];
  /** Whether the model calls tools through the API's tool field. */
  readonly tool_call?: boolean;
  readonly structured_output?: boolean;
  readonly attachment?: boolean;
  readonly modalities?: { readonly input?: readonly string[]; readonly output?: readonly string[] };
  readonly limit?: { context?: number; output?: number };
  /** US dollars per one million tokens. */
  readonly cost?: { input?: number; output?: number; cache_read?: number; cache_write?: number };
  readonly release_date?: string;
  readonly last_updated?: string;
  readonly [key: string]: unknown;
}

export interface CatalogProvider {
  readonly id: string;
  readonly name?: string;
  /** AI SDK package that speaks this provider. Always from data, never code. */
  readonly npm?: string;
  /** API endpoint. */
  readonly api?: string;
  readonly doc?: string;
  /** Environment variables that may hold the key, in preference order. */
  readonly env?: string[];
  readonly models?: Readonly<Record<string, CatalogModel>>;
  readonly [key: string]: unknown;
}

interface CatalogEntry {
  /** Byte offset of this provider's line. */
  offset: number;
  /** Byte length of this provider's line, newline excluded. */
  length: number;
  modelCount: number;
  /** Models this provider has, as of the fetch. Read from the index, not the line. */
  toolCapableCount: number;
}

interface CatalogIndex {
  fetchedAt: string;
  entries: Record<string, CatalogEntry>;
  /** Provider ids serving each model id, so custom providers can match cataloged models. */
  modelProviders?: Record<string, string[]>;
}

export const CATALOG_FILENAMES = ['catalog.ndjson', 'catalog-index.json'] as const;
const NDJSON_FILE = getDataPath(CATALOG_FILENAMES[0]);
const INDEX_FILE = getDataPath(CATALOG_FILENAMES[1]);
const CATALOG_URL = 'https://models.dev/api.json';
const FETCH_TIMEOUT_MS = 8000;
const MAX_CATALOG_BYTES = 20 * 1024 * 1024;
/** A model entry is at most a few hundred bytes; anything larger is a bad line. */
const MAX_PROVIDER_LINE_BYTES = 8 * 1024 * 1024;

/**
 * How long a cached catalog is served without asking the network again.
 *
 * Long enough that repeated runs cost nothing, short enough that a model
 * released this morning is usable today.
 */
export const DEFAULT_CATALOG_TTL_MS = 12 * 60 * 60 * 1000;

/** Backoff after a failed fetch when there is nothing cached to serve. */
const RETRY_DELAY_MS = 60 * 1000;

let index: CatalogIndex | null = null;
let diskRevision: string | null = null;
/** Providers read during this run, so a second lookup costs nothing. */
const loaded = new Map<string, CatalogProvider | null>();
let inFlight: Promise<CatalogIndex> | null = null;
/** Set after a failure with no cache, so a broken network does not spin. */
let retryAfter = 0;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Normalizes one raw provider entry: the API nests models in an object. */
function normalizeProvider(id: string, raw: unknown): CatalogProvider | null {
  if (!isRecord(raw)) return null;
  const models: Record<string, CatalogModel> = {};
  if (isRecord(raw.models)) {
    for (const [modelId, model] of Object.entries(raw.models)) {
      if (isRecord(model)) models[modelId] = { ...model, id: modelId } as CatalogModel;
    }
  }
  return { ...raw, id, models } as CatalogProvider;
}

function isFresh(value: CatalogIndex, nowMs: number, ttlMs: number): boolean {
  const fetchedAt = Date.parse(value.fetchedAt);
  return Number.isFinite(fetchedAt) && nowMs - fetchedAt < ttlMs;
}

function readDiskIndex(): CatalogIndex | null {
  if (!existsSync(INDEX_FILE) || !existsSync(NDJSON_FILE)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(INDEX_FILE, 'utf8'));
    if (!isRecord(parsed) || !isRecord(parsed.entries)) return null;
    const modelProviders = isRecord(parsed.modelProviders)
      ? Object.fromEntries(
          Object.entries(parsed.modelProviders).flatMap(([modelId, providerIds]) =>
            Array.isArray(providerIds) && providerIds.every((providerId) => typeof providerId === 'string')
              ? [[modelId, providerIds as string[]]]
              : [],
          ),
        )
      : undefined;
    return {
      fetchedAt: typeof parsed.fetchedAt === 'string' ? parsed.fetchedAt : '',
      entries: parsed.entries as Record<string, CatalogEntry>,
      ...(modelProviders ? { modelProviders } : {}),
    };
  } catch {
    return null;
  }
}

function currentIndex(): CatalogIndex | null {
  const revision = catalogDiskRevision();
  if (revision !== diskRevision) {
    index = readDiskIndex();
    loaded.clear();
    diskRevision = revision;
  }
  return index;
}

function catalogDiskRevision(): string {
  try {
    return [INDEX_FILE, NDJSON_FILE]
      .map((file) => {
        const stat = statSync(file, { bigint: true });
        return `${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
      })
      .join('|');
  } catch {
    return '';
  }
}

/** Tracks disk replacements across processes, including cached misses and changed byte offsets. */
export function getCatalogRevision(): string {
  currentIndex();
  return diskRevision ?? '';
}

/**
 * Writes the payload as NDJSON and records where each provider landed.
 *
 * The offsets are measured from the bytes actually written, so the index and
 * the file cannot disagree. Both are written to temporary names and renamed, so
 * an interrupted refresh leaves the previous catalog intact.
 *
 * Exported because the on-disk format is a contract: a test that hand-builds an
 * index would be testing its own copy of the layout rather than this writer.
 */
export function writeCatalogSnapshot(payload: unknown, fetchedAt: string): CatalogIndex {
  if (!isRecord(payload)) throw new Error('models.dev returned an invalid provider catalog');
  const source = isRecord(payload.providers) ? payload.providers : payload;

  mkdirSync(dirname(NDJSON_FILE), { recursive: true });
  const ndjsonTemp = `${NDJSON_FILE}.tmp`;
  const indexTemp = `${INDEX_FILE}.tmp`;
  const handle = openSync(ndjsonTemp, 'w');
  const entries: Record<string, CatalogEntry> = {};
  const modelProviders: Record<string, string[]> = {};
  let offset = 0;

  try {
    for (const [id, raw] of Object.entries(source)) {
      const provider = normalizeProvider(id, raw);
      if (!provider) continue;
      const line = `${JSON.stringify(provider)}\n`;
      const buffer = Buffer.from(line, 'utf8');
      writeSync(handle, buffer, 0, buffer.length);
      const modelIds = Object.keys(provider.models ?? {});
      for (const modelId of modelIds) (modelProviders[modelId] ??= []).push(id);
      entries[id] = {
        offset,
        length: buffer.length - 1,
        modelCount: modelIds.length,
        toolCapableCount: modelIds.filter((modelId) => provider.models?.[modelId]?.tool_call === true).length,
      };
      offset += buffer.length;
    }
  } finally {
    closeSync(handle);
  }

  const next: CatalogIndex = { fetchedAt, entries, modelProviders };
  writeFileSync(indexTemp, JSON.stringify(next), 'utf8');
  renameSync(ndjsonTemp, NDJSON_FILE);
  renameSync(indexTemp, INDEX_FILE);
  return next;
}

/** Reads one provider line by its byte range. Small, and the only disk read. */
function readProviderLine(entry: CatalogEntry): CatalogProvider | null {
  if (!Number.isSafeInteger(entry.offset) || !Number.isSafeInteger(entry.length)) return null;
  if (entry.offset < 0 || entry.length <= 0 || entry.length > MAX_PROVIDER_LINE_BYTES) return null;
  const buffer = Buffer.alloc(entry.length);
  let read = 0;
  const handle = openSync(NDJSON_FILE, 'r');
  try {
    while (read < entry.length) {
      const got = readSync(handle, buffer, read, entry.length - read, entry.offset + read);
      if (got <= 0) return null;
      read += got;
    }
  } finally {
    closeSync(handle);
  }
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(buffer.toString('utf8'));
  } catch {
    return null;
  }
  return isRecord(parsed) ? (parsed as unknown as CatalogProvider) : null;
}

/**
 * Reads the response body with a hard byte ceiling. A chunked response carries no
 * `content-length`, so the limit must be enforced while streaming rather than
 * trusting a header.
 */
async function readBoundedJson(response: Response, maxBytes: number): Promise<unknown> {
  const limit = `${Math.floor(maxBytes / (1024 * 1024))} MiB`;
  const contentLength = Number(response.headers.get('content-length') ?? '');
  if (Number.isFinite(contentLength) && contentLength > maxBytes) throw new Error(`the provider catalog exceeded the ${limit} limit`);
  if (!response.body) return response.json();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error(`the provider catalog exceeded the ${limit} limit`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(merged));
  } catch {
    throw new Error('models.dev returned an invalid JSON payload');
  }
}

/**
 * Ensures the catalog index is in hand, fetching only when the cache is stale.
 *
 * A stale cache beats no catalog: when models.dev is unreachable this returns
 * what it has rather than failing, so `ranite` still works with a stale list.
 *
 * `ttlMs`, `now` and `fetchImpl` are injectable so tests exercise both the
 * fresh and the unreachable path without depending on the machine they run on —
 * a test that reaches the internet is a test that fails on someone else's box.
 */
export async function getCatalogIndex(
  options: { refresh?: boolean; ttlMs?: number; now?: () => number; fetchImpl?: typeof globalThis.fetch } = {},
): Promise<CatalogIndex> {
  const now = options.now ?? Date.now;
  const nowMs = now();
  const cached = currentIndex();
  const ttlMs = options.ttlMs ?? DEFAULT_CATALOG_TTL_MS;

  if (!options.refresh && cached && isFresh(cached, nowMs, ttlMs)) return cached;
  if (nowMs < retryAfter) {
    if (cached) return cached;
    throw new Error('the provider catalog is unavailable and nothing is cached yet');
  }
  if (inFlight) return inFlight;

  const doFetch = options.fetchImpl ?? globalThis.fetch;
  inFlight = (async () => {
    try {
      const response = await doFetch(CATALOG_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!response.ok) throw new Error(`models.dev returned HTTP ${response.status}`);
      const payload: unknown = await readBoundedJson(response, MAX_CATALOG_BYTES);

      const next = writeCatalogSnapshot(payload, new Date(nowMs).toISOString());
      index = next;
      loaded.clear();
      retryAfter = 0;
      return next;
    } catch (error) {
      retryAfter = nowMs + RETRY_DELAY_MS;
      if (cached) return cached;
      /* With nothing cached there is nothing to fall back on, so the failure is
         the answer. It is wrapped rather than rethrown raw: a bare "fetch
         failed" does not say which URL, and a first run on a locked-down network
         needs to be able to tell that apart from a bad install. */
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`the provider catalog is unavailable and nothing is cached yet (${CATALOG_URL}: ${reason})`);
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
}

/**
 * One provider, read on demand and then remembered for the rest of the run.
 *
 * Returns null for an id the catalog does not carry. Never hits the network: if
 * the index has not been loaded, the answer is "not known", not "no".
 */
export function getProvider(providerId: string): CatalogProvider | null {
  const catalog = currentIndex();
  if (loaded.has(providerId)) return loaded.get(providerId) ?? null;
  const entry = catalog?.entries[providerId];
  const provider = entry ? readProviderLine(entry) : null;
  // A line whose id does not match its index slot means the pair is torn; the
  // honest answer is "unknown" until the next refresh writes a consistent pair.
  const verified = provider && provider.id === providerId ? provider : null;
  loaded.set(providerId, verified);
  return verified;
}

/** Ids of every provider in the cached catalog, from the index alone. */
export function listProviderIds(): string[] {
  return Object.keys(currentIndex()?.entries ?? {});
}

/** Provider ids that expose this exact model id in the cached models.dev catalog. */
export function listProviderIdsForModel(modelId: string): string[] {
  const catalog = currentIndex();
  if (!catalog) return [];
  if (!catalog.modelProviders) {
    const modelProviders: Record<string, string[]> = {};
    for (const providerId of Object.keys(catalog.entries)) {
      const provider = getProvider(providerId);
      for (const id of Object.keys(provider?.models ?? {})) (modelProviders[id] ??= []).push(providerId);
    }
    catalog.modelProviders = modelProviders;
    try {
      const tempFile = `${INDEX_FILE}.tmp`;
      writeFileSync(tempFile, JSON.stringify(catalog), 'utf8');
      renameSync(tempFile, INDEX_FILE);
    } catch {
      // The in-memory lookup still works when the cache directory is read-only.
    }
  }
  return catalog.modelProviders[modelId] ?? [];
}

/** Per-provider facts held in the index, so listing needs no provider read. */
export function listProviderSummaries(): Array<{ id: string } & CatalogEntry> {
  const entries = currentIndex()?.entries ?? {};
  return Object.entries(entries).map(([id, entry]) => ({ id, ...entry }));
}

export function getModel(providerId: string, modelId: string): CatalogModel | null {
  return getProvider(providerId)?.models?.[modelId] ?? null;
}

/** Token price for a model, or null when the catalog has no price. */
export function getTokenPrice(providerId: string, modelId: string): CatalogModel['cost'] | null {
  return getModel(providerId, modelId)?.cost ?? null;
}

/** Total bytes the catalog occupies on disk. */
export function catalogSizeOnDisk(): number {
  if (!existsSync(NDJSON_FILE)) return 0;
  try {
    return statSync(NDJSON_FILE).size;
  } catch {
    return 0;
  }
}

/**
 * Whether the catalog index is in hand.
 *
 * Every caller that counts models checks this first. A count taken with no
 * index is zero, and zero reads as "this provider has nothing usable", which is
 * a different and wrong claim from "we do not know yet".
 */
export function isCatalogLoaded(): boolean {
  return currentIndex() !== null;
}

/** Clears the in-memory state. Exported for tests. */
export function resetCatalogCacheForTests(): void {
  index = null;
  diskRevision = null;
  loaded.clear();
  inFlight = null;
  retryAfter = 0;
}
