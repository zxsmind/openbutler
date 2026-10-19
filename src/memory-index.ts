import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { lstat, readdir, readFile } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { AllTasks, PretrainedModelOptions, ProgressCallback } from '@huggingface/transformers';
import { getMemoryPaths, teamSlug } from './memory-paths.js';
import { getDataPath } from './paths.js';
import { loadSettings } from './settings.js';
import { migrateMemoryLayout } from './memory-layout.js';
import { tokenizeTerms } from './relevance-gate.js';
import { MEMORY_DOCUMENT_REVISION, parseMemoryDocument, type MemoryScope, type MemoryType } from './memory-document.js';
import { classifyWorkspacePath } from './workspace-scope.js';

export const MEMORY_EMBEDDING_MODEL_NAME = 'all-MiniLM-L6-v2';
export const MEMORY_EMBEDDING_MODEL = `Xenova/${MEMORY_EMBEDDING_MODEL_NAME}`;
export const MEMORY_EMBEDDING_REVISION = '751bff37182d3f1213fa05d7196b954e230abad9';
export const MEMORY_EMBEDDING_DIMENSIONS = 384;

const EMBEDDING_DTYPE = 'q8';
const EMBEDDING_MODEL_FILE = 'onnx/model_quantized.onnx';
/** Identifies the pinned model build alone; indexes that share vectors store this key. */
export const EMBEDDING_RUNTIME_KEY = `${MEMORY_EMBEDDING_MODEL}@${MEMORY_EMBEDDING_REVISION}:${EMBEDDING_DTYPE}`;
const EMBEDDING_MODEL_KEY = `${EMBEDDING_RUNTIME_KEY}:${MEMORY_DOCUMENT_REVISION}`;
const EMBEDDING_BATCH_SIZE = 16;
const MAX_SEQUENCE_LENGTH = 512;
const MAX_SEARCH_RESULTS = 10;
const EMBEDDING_BYTES = MEMORY_EMBEDDING_DIMENSIONS * Float32Array.BYTES_PER_ELEMENT;

/**
 * Relevance gate for memory search, calibrated on the live corpus 2026-10-19.
 *
 * A single absolute floor could not separate the two cases: unrelated rows
 * reached 0.35 on vector noise alone, while correct answers whose wording
 * differs from the note scored 0.49. Measured components on that corpus:
 *
 *   relevant  score 0.91 / 0.79 / 0.54 / 0.49 / 0.47 / 0.44   lexical 0.29-1.00
 *   noise     score 0.35 / 0.29 / 0.19                        lexical 0.00-0.20
 *
 * So a row survives on evidence, not on score alone: a share of the query terms
 * in the note (or an exact phrase/identifier) with a lower floor, or a strong
 * vector match with the higher floor. Unrelated rows have neither.
 */
export const MEMORY_SEARCH_FLOOR = 0.42;
/** Floor for a row that carries lexical, phrase or identifier evidence. */
export const MEMORY_EVIDENCE_FLOOR = 0.35;
/** Share of query terms a note must contain to count as evidence. */
export const MEMORY_LEXICAL_EVIDENCE = 0.25;
/** Vector similarity that stands on its own, with no term overlap. */
export const MEMORY_STRONG_VECTOR = 0.6;
export const MEMORY_SEARCH_BAND_RATIO = 0.65;

export interface MemoryScoredRow {
  score: number;
  vectorScore: number;
  lexicalScore: number;
  exactPhrase: boolean;
  exactIdentifier: boolean;
}

/** Keeps rows that clear both a floor and an evidence test, then trims the tail. */
export function gateMemoryScores<T extends MemoryScoredRow>(scored: readonly T[], limit: number): T[] {
  const kept = scored.filter((item) => {
    const hasEvidence = item.lexicalScore >= MEMORY_LEXICAL_EVIDENCE || item.exactPhrase || item.exactIdentifier;
    if (hasEvidence) return item.score >= MEMORY_EVIDENCE_FLOOR;
    return item.vectorScore >= MEMORY_STRONG_VECTOR && item.score >= MEMORY_SEARCH_FLOOR;
  });
  if (kept.length === 0) return [];
  kept.sort((left, right) => right.score - left.score);
  const topScore = kept[0]!.score;
  return kept.filter((item) => item.score >= topScore * MEMORY_SEARCH_BAND_RATIO).slice(0, limit);
}

interface MemorySourceFile {
  path: string;
  scope: MemoryScope;
}

interface StoredMemoryChunk {
  path: string;
  scope: string;
  start_line: number;
  end_line: number;
  heading: string;
  content: string;
  embedding: Uint8Array;
  type: MemoryType;
  title: string;
  description: string;
}

export interface MemoryMatch {
  path: string;
  startLine: number;
  endLine: number;
  type: MemoryType;
  title: string;
  description: string;
  heading: string;
  score: number;
  snippet: string;
}

export interface MemorySearchResult {
  matches: MemoryMatch[];
  indexedSources: number;
  indexedChunks: number;
  emptyMemory: boolean;
  /** Consistency problems in the MEMORY.md navigation layer; absent when clean. */
  indexIssues?: string[];
}

type EmbeddingRuntime = Awaited<ReturnType<typeof createEmbeddingRuntime>>;
let embeddingRuntimePromise: Promise<EmbeddingRuntime> | undefined;
let embeddingRuntime: EmbeddingRuntime | undefined;
let embeddingRuntimeUsers = 0;

/**
 * One refcounted lease over the shared local embedding runtime, used by both the
 * memory and the session index so the ONNX session loads once per process and
 * unloads when the last owner releases it.
 */
export interface EmbeddingLease {
  acquire(): Promise<void>;
  release(): Promise<void>;
}

export function createEmbeddingLease(): EmbeddingLease {
  let pending: Promise<void> | undefined;
  let acquired = false;
  return {
    async acquire(): Promise<void> {
      if (acquired) return;
      pending ??= acquireEmbeddingRuntime().then(
        () => {
          acquired = true;
        },
        (error: unknown) => {
          pending = undefined;
          throw error;
        },
      );
      await pending;
    },
    async release(): Promise<void> {
      if (!acquired) return;
      acquired = false;
      pending = undefined;
      await releaseEmbeddingRuntime();
    },
  };
}

export interface PrepareMemoryModelOptions {
  onProgress?: ProgressCallback;
  localFilesOnly?: boolean;
}

/**
 * How long an idle search keeps the local model resident. The ONNX session
 * holds ~50 MB of native memory that the JS heap never sees, so a single
 * memory search would otherwise keep it for the whole process lifetime; a rare
 * reload is the cheaper side of that trade.
 */
export const EMBEDDING_IDLE_UNLOAD_MS = 60_000;

/**
 * Refcounted lease with an idle release.
 *
 * Memory search is rare, and holding the ONNX session costs tens of megabytes
 * of native memory that no GC can reclaim. This holds the lease only while a
 * search is running plus `idleMs` afterwards, so a busy moment keeps the model
 * warm and a quiet process gives it back. Acquiring clears a pending release,
 * so a reload can never race a timer into unloading a session in use.
 */
export class EmbeddingIdleLease {
  private held = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private acquiring = 0;

  constructor(
    private readonly lease: EmbeddingLease,
    private readonly idleMs: number = EMBEDDING_IDLE_UNLOAD_MS,
  ) {}

  get isHeld(): boolean {
    return this.held;
  }

  /** Counts a pending acquire, so an idle release cannot run underneath it. */
  get isInUse(): boolean {
    return this.acquiring > 0;
  }

  async acquire(): Promise<void> {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.acquiring += 1;
    try {
      await this.lease.acquire();
      this.held = true;
    } finally {
      this.acquiring -= 1;
    }
  }

  /** Restarts the idle clock; call after the work that needed the model. */
  touch(): void {
    if (!this.held) return;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.release();
    }, this.idleMs);
    this.timer.unref?.();
  }

  async release(): Promise<void> {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.held) return;
    this.held = false;
    await this.lease.release();
  }
}

/** A cheap startup check; the ONNX model itself remains unloaded until search. */
export function isMemoryEmbeddingModelPrepared(): Promise<boolean> {
  return hasCompleteModelCache(memoryModelRevisionDirectory());
}

/** Downloads/caches the pinned model, checks inference, and releases its sessions. */
export async function prepareMemoryEmbeddingModel(options: PrepareMemoryModelOptions = {}): Promise<void> {
  const pipeline = await createEmbeddingPipeline(options);
  try {
    const output = await pipeline(['Local memory search readiness check.'], { pooling: 'mean', normalize: true });
    if (output.dims.length !== 2 || output.dims[0] !== 1 || output.dims[1] !== MEMORY_EMBEDDING_DIMENSIONS) {
      throw new Error(`Expected a ${MEMORY_EMBEDDING_DIMENSIONS}-dimensional memory embedding; got ${output.dims.join('×')}.`);
    }
    const vector = Array.from(output.data as ArrayLike<number>);
    const magnitude = vector.reduce((sum, value) => sum + value * value, 0);
    if (vector.length !== MEMORY_EMBEDDING_DIMENSIONS || !vector.every(Number.isFinite) || magnitude < 0.9 || magnitude > 1.1) {
      throw new Error('The local memory model returned an invalid embedding.');
    }
  } finally {
    await pipeline.dispose();
  }
}

/**
 * Markdown remains the canonical memory. This database contains only derived,
 * refreshable chunks and local embeddings for the active user/workspace scopes.
 */
export class MemoryIndex {
  private readonly paths: ReturnType<typeof getMemoryPaths>;
  private readonly workspaceScope: MemoryScope;
  private database: DatabaseSync | undefined;
  private readonly embedding = new EmbeddingIdleLease(createEmbeddingLease());

  constructor(workspaceRoot = process.cwd()) {
    migrateMemoryLayout(workspaceRoot);
    this.paths = getMemoryPaths(workspaceRoot);
    this.workspaceScope = `workspace:${this.paths.workspaceKey}`;
  }

  private async ensureEmbeddingRuntime(): Promise<void> {
    await this.embedding.acquire();
  }

  /**
   * Scopes the agent may search: the shared user scope, its own self scope,
   * the active workspace, and every team scope. Other workspaces stay out.
   */
  private searchScopeFilter(alias: string): { clause: string; params: string[] } {
    const params = ['user', 'self', this.workspaceScope];
    const teamKey = activeTeamKey();
    if (teamKey) params.push(`team:${teamKey}`);
    return { clause: `${alias}.scope IN (${params.map(() => '?').join(', ')})`, params };
  }

  async reindexPath(path: string): Promise<void> {
    const normalized = normalizePath(path);
    const source = await this.collectSourceFiles();
    const entry = source.find((candidate) => normalizePath(candidate.path) === normalized);
    if (!entry) return;
    const content = await readFile(entry.path, 'utf8');
    await this.indexSource(entry, content);
  }

  async search(query: string, requestedLimit = 5): Promise<MemorySearchResult> {
    const normalizedQuery = query.trim();
    if (!normalizedQuery) throw new Error('query must be a non-empty string.');

    const files = await this.collectSourceFiles();
    const issues = await this.collectIndexIssues(files);
    const issueField = issues.length > 0 ? { indexIssues: issues } : {};
    const database = files.length > 0 || this.database !== undefined ? this.getDatabase() : undefined;
    if (!database) return { matches: [], indexedSources: 0, indexedChunks: 0, emptyMemory: true, ...issueField };

    await this.removeMissingSources(files);
    for (const file of files) {
      const content = await readFile(file.path, 'utf8');
      await this.indexSource(file, content);
    }

    const scopeFilter = this.searchScopeFilter('s');
    const sourceCount = Number(
      database.prepare(`SELECT COUNT(*) AS count FROM memory_sources s WHERE ${scopeFilter.clause}`).get(...scopeFilter.params)?.count ?? 0,
    );
    const chunkCount = Number(
      database
        .prepare(`SELECT COUNT(*) AS count FROM memory_chunks c WHERE ${this.searchScopeFilter('c').clause}`)
        .get(...scopeFilter.params)?.count ?? 0,
    );
    if (chunkCount === 0) {
      return { matches: [], indexedSources: sourceCount, indexedChunks: 0, emptyMemory: sourceCount === 0, ...issueField };
    }

    await this.ensureEmbeddingRuntime();
    const queryEmbedding = (await embedTexts([normalizedQuery]))[0];
    this.embedding.touch();
    if (!queryEmbedding) throw new Error('The local embedding model returned no query vector.');
    const limit = Math.max(1, Math.min(MAX_SEARCH_RESULTS, Math.floor(requestedLimit)));
    const terms = tokenizeTerms(normalizedQuery);
    const queryLower = normalizedQuery.toLowerCase();
    const scored: Array<{
      chunk: StoredMemoryChunk;
      score: number;
      vectorScore: number;
      lexicalScore: number;
      exactPhrase: boolean;
      exactIdentifier: boolean;
    }> = [];
    const chunks = database
      .prepare(
        `
      SELECT c.path, c.scope, c.start_line, c.end_line, c.heading, c.content,
             c.embedding, s.type, s.title, s.description
      FROM memory_chunks c
      JOIN memory_sources s ON s.path = c.path
      WHERE ${this.searchScopeFilter('c').clause}
    `,
      )
      .iterate(...scopeFilter.params);
    // A linear scan scores every chunk; the gates then keep only relevant rows. Add ANN when corpus size makes latency unacceptable.
    for (const row of chunks) {
      const chunk = row as unknown as StoredMemoryChunk;
      const vectorScore = storedVectorSimilarity(queryEmbedding, chunk.embedding);
      const searchable = `${chunk.title}\n${chunk.description}\n${chunk.heading}\n${chunk.content}`.toLowerCase();
      const matchedTerms = terms.filter((term) => searchable.includes(term)).length;
      const lexicalScore = terms.length === 0 ? 0 : matchedTerms / terms.length;
      const exactPhraseBoost = searchable.includes(queryLower) ? 0.2 : 0;
      const exactIdentifierBoost = terms.some((term) => /[\d_-]/.test(term) && searchable.includes(term)) ? 0.15 : 0;
      scored.push({
        chunk,
        score: vectorScore + lexicalScore * 0.12 + exactPhraseBoost + exactIdentifierBoost,
        vectorScore,
        lexicalScore,
        exactPhrase: exactPhraseBoost > 0,
        exactIdentifier: exactIdentifierBoost > 0,
      });
    }

    // With RANITE_MEMORY_DEBUG=1 the gate is skipped, so the top rows and their
    // components are visible; that is how the thresholds get recalibrated.
    const debug = process.env.RANITE_MEMORY_DEBUG === '1';
    const matches = (
      debug ? [...scored].sort((left, right) => right.score - left.score).slice(0, limit) : gateMemoryScores(scored, limit)
    ).map(({ chunk, score, ...components }) => ({
      path: chunk.path,
      startLine: chunk.start_line,
      endLine: chunk.end_line,
      type: chunk.type,
      title: chunk.title,
      description: chunk.description,
      heading: chunk.heading,
      score: Number(score.toFixed(4)),
      snippet: chunk.content.slice(0, 1_800),
      // Opt-in: shows why a row survived the gate, so the thresholds can be
      // recalibrated against a live corpus instead of by guesswork.
      ...(process.env.RANITE_MEMORY_DEBUG === '1'
        ? {
            components: {
              vector: Number(components.vectorScore.toFixed(4)),
              lexical: Number(components.lexicalScore.toFixed(4)),
              phrase: components.exactPhrase,
              identifier: components.exactIdentifier,
            },
          }
        : {}),
    }));
    return { matches, indexedSources: sourceCount, indexedChunks: chunkCount, emptyMemory: sourceCount === 0, ...issueField };
  }

  /**
   * MEMORY.md is machine-checked navigation: report links that dangle or point
   * outside the shared user scope, and user documents that lost their entry.
   * Nothing is rewritten here; entries are repaired on the write path.
   */
  private async collectIndexIssues(files: MemorySourceFile[]): Promise<string[]> {
    const issues: string[] = [];
    let index = '';
    try {
      index = await readFile(this.paths.indexFile, 'utf8');
    } catch (error) {
      if (!isMissingPath(error)) throw error;
    }
    const linked = new Set<string>();
    for (const match of index.matchAll(/^\s*-\s+\[[^\]]+\]\(([^)\s]+)\)(.*)$/gm)) {
      const link = match[1]!.replace(/^<|>$/g, '').split('#', 1)[0]!;
      if (!/\(\d{4}-\d{2}-\d{2}\)\s*$/.test(match[2]!)) issues.push(`MEMORY.md entry has no updated date: ${link}`);
      const target = resolve(dirname(this.paths.indexFile), link);
      linked.add(normalizePath(target));
      let regular = false;
      try {
        const details = await lstat(target);
        regular = details.isFile() && !details.isSymbolicLink();
      } catch {
        // A missing target is reported below.
      }
      if (!regular) issues.push(`MEMORY.md links a missing document: ${link}`);
      else if (!isUserScopedPath(target, this.paths)) issues.push(`MEMORY.md must link only user-scope documents: ${link}`);
    }
    for (const file of files) {
      if (file.scope !== 'user' || linked.has(normalizePath(file.path))) continue;
      issues.push(`User memory document has no MEMORY.md entry: ${relative(this.paths.root, file.path).replace(/\\/g, '/')}`);
    }
    return issues;
  }

  async close(): Promise<void> {
    this.database?.close();
    this.database = undefined;
    await this.embedding.release();
  }

  private getDatabase(): DatabaseSync {
    if (this.database) return this.database;
    const path = getDataPath('state.db');
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const database = new DatabaseSync(path);
    try {
      database.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS memory_sources (
        path TEXT PRIMARY KEY,
        scope TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        model_key TEXT NOT NULL,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        indexed_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS memory_sources_scope_idx ON memory_sources(scope);
      CREATE TABLE IF NOT EXISTS memory_chunks (
        path TEXT NOT NULL REFERENCES memory_sources(path) ON DELETE CASCADE,
        scope TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        start_line INTEGER NOT NULL,
        end_line INTEGER NOT NULL,
        heading TEXT NOT NULL,
        content TEXT NOT NULL,
        embedding BLOB NOT NULL CHECK(length(embedding) = ${EMBEDDING_BYTES}),
        PRIMARY KEY (path, ordinal)
      ) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS memory_chunks_scope_idx ON memory_chunks(scope);
      `);
      const columns = database.prepare('PRAGMA table_info(memory_sources)').all() as Array<{ name: string }>;
      if (!columns.some((column) => column.name === 'description'))
        database.exec("ALTER TABLE memory_sources ADD COLUMN description TEXT NOT NULL DEFAULT ''");
    } catch (error) {
      database.close();
      throw error;
    }
    this.database = database;
    return database;
  }

  private async collectSourceFiles(): Promise<MemorySourceFile[]> {
    const userFiles: MemorySourceFile[] = [];
    const workspaceFiles: MemorySourceFile[] = [];
    const owned = (path: string) => classifyWorkspacePath(path, this.paths.root) === 'workspace';
    if (owned(this.paths.userFile)) await addMarkdownFile(userFiles, this.paths.userFile, 'user');
    if (owned(this.paths.topicsDirectory)) await addMarkdownTree(userFiles, this.paths.topicsDirectory, 'user');
    if (owned(this.paths.areasDirectory)) await addMarkdownTree(userFiles, this.paths.areasDirectory, 'user');
    // Per-agent self scope and the ACTIVE team scope are searchable; other
    // teams' folders (from a left team) are never indexed or searched.
    if (owned(this.paths.peersDirectory)) await addMarkdownTree(userFiles, this.paths.peersDirectory, 'self');
    const teamKey = activeTeamKey();
    if (teamKey && owned(this.paths.teamRoot)) await addMarkdownTree(userFiles, join(this.paths.teamRoot, teamKey), `team:${teamKey}`);
    if (owned(this.paths.workspaceFile)) await addMarkdownFile(workspaceFiles, this.paths.workspaceFile, this.workspaceScope);
    return [...userFiles, ...workspaceFiles].sort((left, right) => left.path.localeCompare(right.path));
  }

  /**
   * Drop indexed sources whose file is gone from disk, in every scope: the
   * active scopes re-add live files below, while deleted or moved workspaces
   * would otherwise leave orphan vectors behind forever. Unreadable files are
   * kept; only confirmed-missing paths are removed.
   */
  private async removeMissingSources(files: MemorySourceFile[]): Promise<void> {
    const database = this.getDatabase();
    const currentPaths = new Set(files.map(({ path }) => normalizePath(path)));
    const knownSources = database.prepare('SELECT path FROM memory_sources').all() as unknown as Array<{ path: string }>;
    const removeSource = database.prepare('DELETE FROM memory_sources WHERE path = ?');
    for (const source of knownSources) {
      if (currentPaths.has(normalizePath(source.path))) continue;
      try {
        await lstat(source.path);
      } catch (error) {
        if (!isMissingPath(error)) continue;
        removeSource.run(source.path);
      }
    }
  }

  private async indexSource(source: MemorySourceFile, content: string): Promise<void> {
    const database = this.getDatabase();
    const contentHash = createHash('sha256').update(content, 'utf8').digest('hex');
    const existing = database.prepare('SELECT content_hash, model_key FROM memory_sources WHERE path = ?').get(source.path) as
      { content_hash?: string; model_key?: string } | undefined;
    if (existing?.content_hash === contentHash && existing.model_key === EMBEDDING_MODEL_KEY) return;

    const document = parseMemoryDocument(content, source.path, source.scope);
    await this.ensureEmbeddingRuntime();
    const embeddings = await embedTexts(document.chunks.map((chunk) => chunk.embeddingText));
    this.embedding.touch();
    if (embeddings.length !== document.chunks.length) {
      throw new Error(`The local embedding model returned ${embeddings.length} vectors for ${document.chunks.length} memory chunks.`);
    }

    database.exec('BEGIN IMMEDIATE');
    try {
      database
        .prepare(
          `
        INSERT INTO memory_sources (path, scope, content_hash, model_key, type, title, description, indexed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(path) DO UPDATE SET
          scope = excluded.scope,
          content_hash = excluded.content_hash,
          model_key = excluded.model_key,
          type = excluded.type,
          title = excluded.title,
          description = excluded.description,
          indexed_at = excluded.indexed_at
      `,
        )
        .run(
          source.path,
          source.scope,
          contentHash,
          EMBEDDING_MODEL_KEY,
          document.type,
          document.title,
          document.description,
          new Date().toISOString(),
        );
      database.prepare('DELETE FROM memory_chunks WHERE path = ?').run(source.path);
      const insertChunk = database.prepare(`
        INSERT INTO memory_chunks (path, scope, ordinal, start_line, end_line, heading, content, embedding)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      document.chunks.forEach((chunk, index) => {
        const embedding = embeddings[index];
        if (!embedding) throw new Error(`Missing memory embedding for ${source.path} chunk ${index}.`);
        insertChunk.run(
          source.path,
          source.scope,
          chunk.ordinal,
          chunk.startLine,
          chunk.endLine,
          chunk.heading,
          chunk.content,
          encodeEmbedding(embedding),
        );
      });
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  }
}

async function acquireEmbeddingRuntime(): Promise<void> {
  // The claim is counted before loading so a concurrent close can never unload the shared runtime
  // while an acquirer is still waiting for it.
  embeddingRuntimeUsers++;
  try {
    if (!embeddingRuntimePromise) {
      const loading = createEmbeddingRuntime().then((runtime) => {
        embeddingRuntime = runtime;
        return runtime;
      });
      embeddingRuntimePromise = loading.catch((error: unknown) => {
        embeddingRuntimePromise = undefined;
        throw error;
      });
    }
    await embeddingRuntimePromise;
  } catch (error) {
    embeddingRuntimeUsers--;
    throw error;
  }
}

/** Releases one owner; the shared runtime unloads when the last owner releases it. */
async function releaseEmbeddingRuntime(): Promise<void> {
  if (embeddingRuntimeUsers > 0) embeddingRuntimeUsers--;
  if (embeddingRuntimeUsers > 0 || !embeddingRuntime) return;
  const runtime = embeddingRuntime;
  embeddingRuntime = undefined;
  embeddingRuntimePromise = undefined;
  await runtime.session.release();
}

async function createEmbeddingRuntime() {
  const modelDirectory = memoryModelRevisionDirectory();
  if (!(await hasCompleteModelCache(modelDirectory))) {
    throw new Error('The local memory model is not prepared. Run `ranite setup` and choose ”Prepare local memory model only”.');
  }

  const [{ Tokenizer }, ort] = await Promise.all([import('@huggingface/tokenizers'), import('onnxruntime-node')]);
  const [tokenizerJson, tokenizerConfig] = await Promise.all([
    readFile(join(modelDirectory, 'tokenizer.json'), 'utf8').then((text) => JSON.parse(text) as object),
    readFile(join(modelDirectory, 'tokenizer_config.json'), 'utf8').then((text) => JSON.parse(text) as object),
  ]);
  const tokenizer = new Tokenizer(tokenizerJson, tokenizerConfig);
  const session = await ort.InferenceSession.create(join(modelDirectory, EMBEDDING_MODEL_FILE), {
    executionProviders: ['cpu'],
    intraOpNumThreads: 1,
    interOpNumThreads: 1,
    enableCpuMemArena: false,
    enableMemPattern: false,
  });
  const expectedInputs = ['input_ids', 'attention_mask', 'token_type_ids'];
  if (expectedInputs.some((name) => !session.inputNames.includes(name)) || !session.outputNames.includes('last_hidden_state')) {
    await session.release();
    throw new Error('The cached memory model has an unexpected ONNX input/output contract.');
  }
  return { session, tokenizer, Tensor: ort.Tensor };
}

function memoryModelRevisionDirectory(): string {
  return join(getDataPath('models'), MEMORY_EMBEDDING_MODEL, MEMORY_EMBEDDING_REVISION);
}

async function hasCompleteModelCache(directory: string): Promise<boolean> {
  const files = ['config.json', 'tokenizer.json', 'tokenizer_config.json', EMBEDDING_MODEL_FILE];
  const results = await Promise.allSettled(files.map((file) => lstat(join(directory, file))));
  return results.every((result) => result.status === 'fulfilled' && result.value.isFile());
}

async function createEmbeddingPipeline(options: PrepareMemoryModelOptions = {}): Promise<AllTasks['feature-extraction']> {
  const { AutoModel, AutoTokenizer, FeatureExtractionPipeline } = await import('@huggingface/transformers');
  const cachedDirectory = memoryModelRevisionDirectory();
  const cacheComplete = await hasCompleteModelCache(cachedDirectory);
  const modelPath = options.localFilesOnly || cacheComplete ? cachedDirectory : MEMORY_EMBEDDING_MODEL;
  const modelOptions: PretrainedModelOptions = {
    cache_dir: getDataPath('models'),
    revision: MEMORY_EMBEDDING_REVISION,
    dtype: EMBEDDING_DTYPE,
    device: 'cpu',
    ...(options.onProgress ? { progress_callback: options.onProgress } : {}),
    ...(options.localFilesOnly || cacheComplete ? { local_files_only: true } : {}),
  };
  // Transformers.js 4.3 metadata discovery drops cache/revision/offline flags.
  // A complete pinned cache is loaded by its local path to avoid those requests.
  const tokenizer = await AutoTokenizer.from_pretrained(modelPath, modelOptions);
  const model = await AutoModel.from_pretrained(modelPath, modelOptions);
  const instance = new FeatureExtractionPipeline({ task: 'feature-extraction', tokenizer, model });
  options.onProgress?.({ status: 'ready', task: 'feature-extraction', model: MEMORY_EMBEDDING_MODEL });
  return instance;
}

export async function embedTexts(texts: string[]): Promise<Float32Array[]> {
  if (texts.length === 0) return [];
  if (!embeddingRuntime) throw new Error('The local memory model is not loaded.');
  const runtime = embeddingRuntime;
  const vectors: Float32Array[] = [];
  for (let offset = 0; offset < texts.length; offset += EMBEDDING_BATCH_SIZE) {
    const batch = texts.slice(offset, offset + EMBEDDING_BATCH_SIZE);
    const encodings = batch.map((text) => {
      const encoded = runtime.tokenizer.encode(text, { return_token_type_ids: true });
      if (encoded.ids.length <= MAX_SEQUENCE_LENGTH) return encoded;
      return {
        ...encoded,
        ids: [...encoded.ids.slice(0, MAX_SEQUENCE_LENGTH - 1), encoded.ids.at(-1)!],
        attention_mask: [...encoded.attention_mask.slice(0, MAX_SEQUENCE_LENGTH - 1), encoded.attention_mask.at(-1)!],
        token_type_ids: [...(encoded.token_type_ids ?? []).slice(0, MAX_SEQUENCE_LENGTH - 1), encoded.token_type_ids?.at(-1) ?? 0],
      };
    });
    const sequenceLength = Math.max(...encodings.map((encoding) => encoding.ids.length));
    const dimensions: [number, number] = [batch.length, sequenceLength];
    const elementCount = batch.length * sequenceLength;
    const ids = new BigInt64Array(elementCount);
    const attentionMask = new BigInt64Array(elementCount);
    const tokenTypeIds = new BigInt64Array(elementCount);
    for (let row = 0; row < encodings.length; row++) {
      const encoding = encodings[row]!;
      const offset = row * sequenceLength;
      for (let column = 0; column < encoding.ids.length; column++) {
        const index = offset + column;
        ids[index] = BigInt(encoding.ids[column]!);
        attentionMask[index] = BigInt(encoding.attention_mask[column]!);
        tokenTypeIds[index] = BigInt(encoding.token_type_ids?.[column] ?? 0);
      }
    }

    const output = await runtime.session.run({
      input_ids: new runtime.Tensor('int64', ids, dimensions),
      attention_mask: new runtime.Tensor('int64', attentionMask, dimensions),
      token_type_ids: new runtime.Tensor('int64', tokenTypeIds, dimensions),
    });
    const hidden = output.last_hidden_state;
    if (
      !hidden ||
      hidden.dims.length !== 3 ||
      hidden.dims[0] !== batch.length ||
      hidden.dims[1] !== sequenceLength ||
      hidden.dims[2] !== MEMORY_EMBEDDING_DIMENSIONS
    ) {
      throw new Error(`Expected ${batch.length} local memory embeddings with ${MEMORY_EMBEDDING_DIMENSIONS} dimensions.`);
    }
    const hiddenData = hidden.data as Float32Array;
    for (let row = 0; row < batch.length; row++) {
      const vector = new Float32Array(MEMORY_EMBEDDING_DIMENSIONS);
      let tokenCount = 0;
      for (let column = 0; column < encodings[row]!.attention_mask.length; column++) {
        if (encodings[row]!.attention_mask[column] !== 1) continue;
        tokenCount++;
        const tokenOffset = (row * sequenceLength + column) * MEMORY_EMBEDDING_DIMENSIONS;
        for (let dimension = 0; dimension < MEMORY_EMBEDDING_DIMENSIONS; dimension++) {
          vector[dimension]! += hiddenData[tokenOffset + dimension]!;
        }
      }
      let magnitude = 0;
      for (let dimension = 0; dimension < MEMORY_EMBEDDING_DIMENSIONS; dimension++) {
        vector[dimension]! /= tokenCount;
        magnitude += vector[dimension]! * vector[dimension]!;
      }
      magnitude = Math.sqrt(magnitude);
      if (!Number.isFinite(magnitude) || magnitude === 0) throw new Error('The local memory model returned an invalid embedding.');
      for (let dimension = 0; dimension < MEMORY_EMBEDDING_DIMENSIONS; dimension++) vector[dimension]! /= magnitude;
      vectors.push(vector);
    }
  }
  return vectors;
}

async function addMarkdownFile(output: MemorySourceFile[], path: string, scope: MemoryScope): Promise<void> {
  try {
    const details = await lstat(path);
    if (details.isFile() && !details.isSymbolicLink() && path.toLowerCase().endsWith('.md')) output.push({ path, scope });
  } catch (error) {
    if (!isMissingPath(error)) throw error;
  }
}

async function addMarkdownTree(output: MemorySourceFile[], directory: string, scope: MemoryScope): Promise<void> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (isMissingPath(error)) return;
    throw error;
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) await addMarkdownTree(output, path, scope);
    else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) output.push({ path, scope });
  }
}

function isMissingPath(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

/**
 * The folder key of the team this machine is currently in, or null. Only that
 * team's shared memory is indexed and searched; a left team's folder stays on
 * disk but never leaks into later work.
 */
function activeTeamKey(): string | null {
  try {
    const team = loadSettings().team;
    if (!team) return null;
    return team.teamId || teamSlug(team.teamName);
  } catch {
    return null;
  }
}

export function encodeEmbedding(embedding: Float32Array): Buffer {
  if (embedding.length !== MEMORY_EMBEDDING_DIMENSIONS) {
    throw new Error(`Expected an embedding of ${MEMORY_EMBEDDING_DIMENSIONS} dimensions; got ${embedding.length}.`);
  }
  const bytes = Buffer.allocUnsafe(EMBEDDING_BYTES);
  embedding.forEach((value, index) => bytes.writeFloatLE(value, index * Float32Array.BYTES_PER_ELEMENT));
  return bytes;
}

export function storedVectorSimilarity(query: Float32Array, bytes: Uint8Array): number {
  if (bytes.byteLength !== EMBEDDING_BYTES) throw new Error(`Invalid stored memory vector length: ${bytes.byteLength}.`);
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let dot = 0;
  for (let index = 0; index < MEMORY_EMBEDDING_DIMENSIONS; index++) {
    dot += query[index]! * buffer.readFloatLE(index * Float32Array.BYTES_PER_ELEMENT);
  }
  return dot;
}

function normalizePath(path: string): string {
  const normalized = resolve(path);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function isUserScopedPath(
  target: string,
  paths: {
    preferencesFile: string;
    userFile: string;
    topicsDirectory: string;
    areasDirectory: string;
  },
): boolean {
  const normalizedTarget = normalizePath(target);
  if (normalizedTarget === normalizePath(paths.preferencesFile)) return true;
  if (normalizedTarget === normalizePath(paths.userFile)) return true;
  for (const directory of [paths.topicsDirectory, paths.areasDirectory]) {
    const difference = relative(normalizePath(directory), normalizedTarget);
    if (difference !== '' && !isAbsolute(difference) && !difference.startsWith('..')) return true;
  }
  return false;
}
