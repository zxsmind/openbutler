import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { dirname, resolve } from 'node:path';
import {
  createEmbeddingLease,
  embedTexts,
  EMBEDDING_RUNTIME_KEY,
  encodeEmbedding,
  isMemoryEmbeddingModelPrepared,
  MEMORY_EMBEDDING_DIMENSIONS,
  storedVectorSimilarity,
} from './memory-index.js';
import { getDataPath } from './paths.js';
import { gateByRelevance, tokenizeTerms, type RelevanceGate } from './relevance-gate.js';
import { redactSensitiveText } from './sensitive-data.js';
import { listSessionFiles, loadSavedSession, samePath, type SessionFileInfo } from './session-store.js';

/**
 * The derived, rebuildable session-transcript search index, stored next to the
 * activity ledger and memory chunks in state.db. Session files on disk stay the
 * only source of truth: every row here can be rebuilt from them, and pruning a
 * session file or rebuilding the index never loses conversation state.
 *
 * Search is lexical first (SQLite FTS5 with bm25 ordering) and gets a semantic
 * rerank whenever vectors are already stored. Vector population is exclusive to
 * the explicit `ranite sessions index` command, never to a search: measured on a
 * live corpus, one user message embeds in ~20 ms while one long assistant reply
 * costs ~120 ms (batches pad to their longest member), so embedding the whole
 * corpus inside an interactive search is not affordable. User and notice
 * messages are embedded (they carry the asks and decisions); assistant replies
 * and tool text stay lexical-only, where prefix matching already works well.
 * When no vectors exist, search is fully functional — only the rerank is absent.
 */

export const SESSION_SEARCH_FLOOR = 0.3;
export const SESSION_SEARCH_BAND_RATIO = 0.65;
export const SESSION_SEARCH_GATE: RelevanceGate = { floor: SESSION_SEARCH_FLOOR, bandRatio: SESSION_SEARCH_BAND_RATIO };

export type SessionChunkKind = 'user' | 'assistant' | 'notice' | 'command' | 'output';

const EMBEDDED_KINDS: readonly SessionChunkKind[] = ['user', 'notice'];
const EMBEDDED_KIND_SET = new Set<string>(EMBEDDED_KINDS);
const EMBEDDING_BYTES = MEMORY_EMBEDDING_DIMENSIONS * Float32Array.BYTES_PER_ELEMENT;
/** Upper bound on FTS candidates scored per query; bm25 ordering picks the best ones first. */
const MAX_CANDIDATES = 400;
/** Upper bound on stored vectors scanned per query, newest sessions first. */
const SEMANTIC_SCAN_LIMIT = 20_000;
export const SESSION_SEARCH_MAX_LIMIT = 50;
export const SESSION_SEARCH_DEFAULT_LIMIT = 8;
/** Bounds the latency of one embedding slice; the CLI drains the backlog in rounds. */
const MAX_EMBEDS_PER_RUN = 256;

export interface SessionSearchOptions {
  query: string;
  /** 'all' (default) spans every workspace on this machine; 'workspace' narrows to the active one. */
  scope?: 'all' | 'workspace';
  /** Include tool output chunks, which are excluded by default. */
  includeOutputs?: boolean;
  limit?: number;
  offset?: number;
}

export interface SessionSearchMatch {
  sessionId: string;
  title: string;
  workspaceRoot?: string;
  updatedAt: string;
  /** 1-based display-entry number, the same numbering session_read windows use. */
  entry: number;
  kind: SessionChunkKind;
  snippet: string;
  score: number;
}

export interface SessionSearchResult {
  matches: SessionSearchMatch[];
  total: number;
  nextOffset?: number;
  indexedSessions: number;
  indexedEntries: number;
  indexedEmbeddings: number;
  pendingEmbeddings: number;
}

export interface SessionIndexCounts {
  sessions: number;
  entries: number;
  embeddings: number;
  pendingEmbeddings: number;
}

interface IndexedRow {
  entry: number;
  chunk: number;
  kind: SessionChunkKind;
  text: string;
  sha: string;
  /** Reused vector from the previous index run, or null when the row must be embedded. */
  embedding: Uint8Array | null;
}

interface CandidateRow {
  sessionId: string;
  entry: number;
  chunk: number;
  text: string;
  kind: SessionChunkKind;
  title: string;
  workspaceRoot: string | null;
  updatedAt: string;
  excerpt: string;
}

export class SessionIndex {
  private readonly workspaceRoot: string;
  private database: DatabaseSync | undefined;
  private readonly embeddingLease = createEmbeddingLease();

  constructor(workspaceRoot = process.cwd()) {
    this.workspaceRoot = resolve(workspaceRoot);
  }

  /**
   * Brings the derived index in line with the session files on disk: vanished
   * files lose their rows, changed files are re-read, unchanged files are left
   * alone (mtime and size decide), and a damaged file never leaves stale rows
   * behind. Vector population is deliberately not part of this path; the
   * `ranite sessions index` command drains the backlog.
   */
  async ensureIndexed(): Promise<void> {
    const files = listSessionFiles();
    const database = this.getDatabase();
    const fileById = new Map(files.map((file) => [file.id, file]));
    const known = new Map<string, { mtime: number; size: number }>();
    for (const row of database.prepare('SELECT session_id, file_mtime_ms, file_size_bytes FROM session_sources').iterate()) {
      const known_row = row as { session_id: string; file_mtime_ms: number; file_size_bytes: number };
      known.set(known_row.session_id, { mtime: known_row.file_mtime_ms, size: known_row.file_size_bytes });
    }
    for (const id of known.keys()) {
      if (!fileById.has(id)) this.dropSession(id);
    }
    for (const file of files) {
      const prior = known.get(file.id);
      if (prior && prior.mtime === Math.floor(file.modifiedAt) && prior.size === file.sizeBytes) continue;
      if (!this.indexSession(file)) this.dropSession(file.id);
    }
  }

  async search(options: SessionSearchOptions): Promise<SessionSearchResult> {
    const query = options.query.trim();
    if (!query) throw new Error('query must be a non-empty string.');
    const limit = clampInteger(options.limit ?? SESSION_SEARCH_DEFAULT_LIMIT, 1, SESSION_SEARCH_MAX_LIMIT);
    const offset = Math.max(0, clampInteger(options.offset ?? 0, 0, Number.MAX_SAFE_INTEGER));
    const includeOutputs = options.includeOutputs === true;
    const scope = options.scope === 'workspace' ? 'workspace' : 'all';

    await this.ensureIndexed();
    const database = this.getDatabase();
    const counts = this.collectCounts(database);
    const terms = tokenizeTerms(query);
    if (terms.length === 0) return { matches: [], total: 0, ...indexedCounts(counts) };

    const ftsQuery = terms.map((term) => `"${term.replace(/"/g, '""')}"*`).join(' OR ');
    const candidates = database
      .prepare(
        `
      SELECT session_fts.session_id AS sessionId, session_fts.entry AS entry, session_fts.chunk AS chunk,
             session_fts.text AS text, e.kind AS kind,
             s.title AS title, s.workspace_root AS workspaceRoot, s.updated_at AS updatedAt,
             snippet(session_fts, 0, '', '', '…', 16) AS excerpt
      FROM session_fts
      JOIN session_entries e ON e.session_id = session_fts.session_id AND e.entry = session_fts.entry AND e.chunk = session_fts.chunk
      JOIN session_sources s ON s.session_id = session_fts.session_id
      WHERE session_fts MATCH ?
      ORDER BY bm25(session_fts)
      LIMIT ${MAX_CANDIDATES}
    `,
      )
      .all(ftsQuery) as unknown as CandidateRow[];

    const queryEmbedding = await this.embedQuery(query);
    const foldedTerms = terms.map(fold);
    const foldedQuery = fold(query);
    const lexicalScore = (text: string): number => {
      const textFold = fold(text);
      const matched = foldedTerms.filter((term) => textFold.includes(term)).length;
      const coverage = matched / terms.length;
      const phraseBoost = textFold.includes(foldedQuery) ? 0.2 : 0;
      const identifierBoost = terms.some((term, index) => /[\d_-]/.test(term) && textFold.includes(foldedTerms[index]!)) ? 0.15 : 0;
      return coverage + phraseBoost + identifierBoost;
    };
    const passesFilters = (candidate: { kind: SessionChunkKind; workspaceRoot: string | null }): boolean => {
      if (!includeOutputs && candidate.kind === 'output') return false;
      if (scope === 'workspace' && (candidate.workspaceRoot === null || !samePath(candidate.workspaceRoot, this.workspaceRoot)))
        return false;
      return true;
    };

    const byKey = new Map<string, { candidate: CandidateRow; lexical: number; cosine?: number }>();
    for (const candidate of candidates) {
      if (!passesFilters(candidate)) continue;
      byKey.set(`${candidate.sessionId}:${candidate.entry}:${candidate.chunk}`, { candidate, lexical: lexicalScore(candidate.text) });
    }
    // Semantic pass: a linear scan over the stored vectors (bounded by SEMANTIC_SCAN_LIMIT) adds
    // rows FTS could not recall and reranks the rows both sides matched. Cheap while the corpus is
    // small; move to an ANN index when the vector count makes the scan noticeable.
    if (queryEmbedding) {
      const embedded = database
        .prepare(
          `
        SELECT e.session_id AS sessionId, e.entry AS entry, e.chunk AS chunk, e.text AS text, e.embedding AS embedding,
               e.kind AS kind, s.title AS title, s.workspace_root AS workspaceRoot, s.updated_at AS updatedAt
        FROM session_entries e
        JOIN session_sources s ON s.session_id = e.session_id
        WHERE e.embedding IS NOT NULL
        ORDER BY s.updated_at DESC
        LIMIT ${SEMANTIC_SCAN_LIMIT}
      `,
        )
        .all() as unknown as Array<Omit<CandidateRow, 'excerpt'> & { embedding: Uint8Array }>;
      for (const row of embedded) {
        if (!passesFilters(row)) continue;
        const cosine = storedVectorSimilarity(queryEmbedding, row.embedding);
        const key = `${row.sessionId}:${row.entry}:${row.chunk}`;
        const existing = byKey.get(key);
        if (existing) {
          existing.cosine = cosine;
          continue;
        }
        byKey.set(key, {
          candidate: { ...row, excerpt: plainSnippet(row.text, foldedTerms) },
          lexical: lexicalScore(row.text),
          cosine,
        });
      }
    }
    const scored = [...byKey.values()].map(({ candidate, lexical, cosine }) => ({
      candidate,
      score: cosine === undefined ? lexical : cosine + lexical * 0.12,
    }));

    const gated = gateByRelevance(scored, scored.length, SESSION_SEARCH_GATE);
    const page = gated.slice(offset, offset + limit);
    const nextOffset = offset + page.length < gated.length ? offset + page.length : undefined;
    const matches = page.map(({ candidate, score }) => ({
      sessionId: candidate.sessionId,
      title: redactSensitiveText(candidate.title),
      ...(candidate.workspaceRoot === null ? {} : { workspaceRoot: candidate.workspaceRoot }),
      updatedAt: candidate.updatedAt,
      entry: candidate.entry,
      kind: candidate.kind,
      snippet: redactSensitiveText(candidate.excerpt || candidate.text.slice(0, 200)),
      score: Number(score.toFixed(4)),
    }));
    return { matches, total: gated.length, ...(nextOffset === undefined ? {} : { nextOffset }), ...indexedCounts(counts) };
  }

  /**
   * Embeds one bounded slice of the backlog, newest sessions first, reusing
   * vectors whose text is unchanged. Returns the number of rows it processed, so
   * callers can drain the backlog in rounds. A missing or broken local model is
   * not an error here: lexical search works without vectors, so embedding
   * failures degrade silently.
   */
  async embedPending(): Promise<number> {
    const database = this.getDatabase();
    const pending = database
      .prepare(
        `
      SELECT e.session_id AS sessionId, e.entry AS entry, e.chunk AS chunk, e.text AS text
      FROM session_entries e
      JOIN session_sources s ON s.session_id = e.session_id
      WHERE e.embedding IS NULL AND e.kind IN (${EMBEDDED_KINDS.map(() => '?').join(', ')})
      ORDER BY s.updated_at DESC
      LIMIT ?
    `,
      )
      .all(...EMBEDDED_KINDS, MAX_EMBEDS_PER_RUN) as unknown as Array<{ sessionId: string; entry: number; chunk: number; text: string }>;
    if (pending.length === 0) return 0;
    if (!(await isMemoryEmbeddingModelPrepared())) return 0;
    try {
      await this.embeddingLease.acquire();
      const vectors = await embedTexts(pending.map((row) => row.text));
      const update = database.prepare('UPDATE session_entries SET embedding = ? WHERE session_id = ? AND entry = ? AND chunk = ?');
      const sessions = new Set<string>();
      pending.forEach((row, index) => {
        const vector = vectors[index];
        if (!vector) return;
        update.run(encodeEmbedding(vector), row.sessionId, row.entry, row.chunk);
        sessions.add(row.sessionId);
      });
      const complete = database.prepare(`
        UPDATE session_sources SET embedding_model_key = ?
        WHERE session_id = ? AND NOT EXISTS (
          SELECT 1 FROM session_entries WHERE session_id = ? AND embedding IS NULL AND kind IN (${EMBEDDED_KINDS.map(() => '?').join(', ')})
        )
      `);
      for (const sessionId of sessions) complete.run(EMBEDDING_RUNTIME_KEY, sessionId, sessionId, ...EMBEDDED_KINDS);
      return pending.length;
    } catch {
      return 0;
    }
  }

  /** Drops the derived tables so the next ensureIndexed rebuilds them from the session files. */
  rebuild(): void {
    const database = this.getDatabase();
    database.exec('DROP TABLE IF EXISTS session_fts; DROP TABLE IF EXISTS session_entries; DROP TABLE IF EXISTS session_sources;');
    this.createSchema(database);
  }

  /** Removes the indexed rows of deleted sessions; pruning calls this alongside file deletion. */
  removeSessions(sessionIds: readonly string[]): void {
    for (const sessionId of sessionIds) this.dropSession(sessionId);
  }

  collectCounts(database: DatabaseSync = this.getDatabase()): SessionIndexCounts {
    const count = (sql: string, parameters: readonly string[] = []): number => {
      const row = database.prepare(sql).get(...parameters) as { count?: number | bigint } | undefined;
      return Number(row?.count ?? 0);
    };
    return {
      sessions: count('SELECT COUNT(*) AS count FROM session_sources'),
      entries: count('SELECT COUNT(*) AS count FROM session_entries'),
      embeddings: count('SELECT COUNT(*) AS count FROM session_entries WHERE embedding IS NOT NULL'),
      pendingEmbeddings: count(
        `SELECT COUNT(*) AS count FROM session_entries WHERE embedding IS NULL AND kind IN (${EMBEDDED_KINDS.map(() => '?').join(', ')})`,
        EMBEDDED_KINDS,
      ),
    };
  }

  async close(): Promise<void> {
    this.database?.close();
    this.database = undefined;
    await this.embeddingLease.release();
  }

  private async embedQuery(query: string): Promise<Float32Array | undefined> {
    const hasVectors = this.getDatabase().prepare('SELECT 1 AS present FROM session_entries WHERE embedding IS NOT NULL LIMIT 1').get();
    if (!hasVectors) return undefined;
    try {
      await this.embeddingLease.acquire();
      return (await embedTexts([query]))[0];
    } catch {
      return undefined;
    }
  }

  private indexSession(file: SessionFileInfo): boolean {
    let session: ReturnType<typeof loadSavedSession>;
    try {
      session = loadSavedSession(file.id);
    } catch {
      return false;
    }
    if (session === null) return false;

    const rows: IndexedRow[] = [];
    let entryNumber = 0;
    for (const entry of session.entries) {
      if (entry.kind === 'reasoning') continue;
      entryNumber += 1;
      if (entry.kind === 'tool') {
        if (entry.command.trim()) rows.push(indexedRow(entryNumber, 0, 'command', entry.command));
        if (entry.result.trim()) rows.push(indexedRow(entryNumber, 1, 'output', entry.result));
      } else if (entry.text.trim()) {
        rows.push(indexedRow(entryNumber, 0, entry.kind, entry.text));
      }
    }

    const database = this.getDatabase();
    const storedKey =
      (
        database.prepare('SELECT embedding_model_key FROM session_sources WHERE session_id = ?').get(file.id) as
          { embedding_model_key: string } | undefined
      )?.embedding_model_key ?? '';
    const reuseVectors = storedKey === EMBEDDING_RUNTIME_KEY;
    const previous = new Map<string, { sha: string; embedding: Uint8Array | null }>();
    for (const row of database
      .prepare('SELECT entry, chunk, text_sha, embedding FROM session_entries WHERE session_id = ?')
      .iterate(file.id)) {
      const previous_row = row as { entry: number; chunk: number; text_sha: string; embedding: Uint8Array | null };
      previous.set(`${previous_row.entry}:${previous_row.chunk}`, { sha: previous_row.text_sha, embedding: previous_row.embedding });
    }
    let embeddingsComplete = true;
    for (const row of rows) {
      const reused = reuseVectors ? previous.get(`${row.entry}:${row.chunk}`) : undefined;
      row.embedding = reused && reused.sha === row.sha ? reused.embedding : null;
      if (EMBEDDED_KIND_SET.has(row.kind) && row.embedding === null) embeddingsComplete = false;
    }
    const modelKey = embeddingsComplete ? EMBEDDING_RUNTIME_KEY : '';

    database.exec('BEGIN IMMEDIATE');
    try {
      database
        .prepare(
          `
        INSERT INTO session_sources (session_id, title, workspace_root, updated_at, entries_count, file_mtime_ms, file_size_bytes, embedding_model_key, indexed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(session_id) DO UPDATE SET
          title = excluded.title,
          workspace_root = excluded.workspace_root,
          updated_at = excluded.updated_at,
          entries_count = excluded.entries_count,
          file_mtime_ms = excluded.file_mtime_ms,
          file_size_bytes = excluded.file_size_bytes,
          embedding_model_key = excluded.embedding_model_key,
          indexed_at = excluded.indexed_at
      `,
        )
        .run(
          file.id,
          session.title,
          session.workspaceRoot ?? null,
          session.updatedAt,
          entryNumber,
          Math.floor(file.modifiedAt),
          file.sizeBytes,
          modelKey,
          new Date().toISOString(),
        );
      database.prepare('DELETE FROM session_entries WHERE session_id = ?').run(file.id);
      database.prepare('DELETE FROM session_fts WHERE session_id = ?').run(file.id);
      const insertEntry = database.prepare(
        'INSERT INTO session_entries (session_id, entry, chunk, kind, text, text_sha, embedding) VALUES (?, ?, ?, ?, ?, ?, ?)',
      );
      const insertFts = database.prepare('INSERT INTO session_fts (text, session_id, entry, chunk) VALUES (?, ?, ?, ?)');
      for (const row of rows) {
        insertEntry.run(file.id, row.entry, row.chunk, row.kind, row.text, row.sha, row.embedding);
        insertFts.run(row.text, file.id, row.entry, row.chunk);
      }
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
    return true;
  }

  private dropSession(sessionId: string): void {
    const database = this.getDatabase();
    database.prepare('DELETE FROM session_entries WHERE session_id = ?').run(sessionId);
    database.prepare('DELETE FROM session_fts WHERE session_id = ?').run(sessionId);
    database.prepare('DELETE FROM session_sources WHERE session_id = ?').run(sessionId);
  }

  private getDatabase(): DatabaseSync {
    if (this.database) return this.database;
    const path = getDataPath('state.db');
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const database = new DatabaseSync(path);
    try {
      database.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
      this.createSchema(database);
    } catch (error) {
      database.close();
      throw error;
    }
    this.database = database;
    return database;
  }

  private createSchema(database: DatabaseSync): void {
    database.exec(`
      CREATE TABLE IF NOT EXISTS session_sources (
        session_id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        workspace_root TEXT,
        updated_at TEXT NOT NULL,
        entries_count INTEGER NOT NULL,
        file_mtime_ms INTEGER NOT NULL,
        file_size_bytes INTEGER NOT NULL,
        embedding_model_key TEXT NOT NULL DEFAULT '',
        indexed_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS session_sources_workspace_idx ON session_sources(workspace_root);
      CREATE TABLE IF NOT EXISTS session_entries (
        session_id TEXT NOT NULL,
        entry INTEGER NOT NULL,
        chunk INTEGER NOT NULL,
        kind TEXT NOT NULL,
        text TEXT NOT NULL,
        text_sha TEXT NOT NULL,
        embedding BLOB CHECK(embedding IS NULL OR length(embedding) = ${EMBEDDING_BYTES}),
        PRIMARY KEY (session_id, entry, chunk)
      ) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS session_entries_kind_idx ON session_entries(kind);
      CREATE VIRTUAL TABLE IF NOT EXISTS session_fts USING fts5(text, session_id UNINDEXED, entry UNINDEXED, chunk UNINDEXED);
    `);
  }
}

function indexedRow(entry: number, chunk: number, kind: SessionChunkKind, text: string): IndexedRow {
  return { entry, chunk, kind, text, sha: createHash('sha256').update(text, 'utf8').digest('hex'), embedding: null };
}

function indexedCounts(
  counts: SessionIndexCounts,
): Pick<SessionSearchResult, 'indexedSessions' | 'indexedEntries' | 'indexedEmbeddings' | 'pendingEmbeddings'> {
  return {
    indexedSessions: counts.sessions,
    indexedEntries: counts.entries,
    indexedEmbeddings: counts.embeddings,
    pendingEmbeddings: counts.pendingEmbeddings,
  };
}

function clampInteger(value: number, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value)) return minimum;
  return Math.max(minimum, Math.min(maximum, value));
}

/** Case- and diacritic-insensitive folding, so Turkish text matches across İ/ı and accents. */
function fold(value: string): string {
  return value.toLowerCase().normalize('NFKD').replace(/\p{M}/gu, '');
}

/** A plain excerpt around the first matched term, for rows the FTS snippet did not cover. */
function plainSnippet(text: string, foldedTerms: readonly string[]): string {
  const foldedText = fold(text);
  let position = -1;
  for (const term of foldedTerms) {
    const at = foldedText.indexOf(term);
    if (at >= 0 && (position < 0 || at < position)) position = at;
  }
  if (position < 0) return text.slice(0, 200);
  const start = Math.max(0, position - 60);
  const body = text.slice(start, start + 200);
  return `${start > 0 ? '…' : ''}${body}${start + 200 < text.length ? '…' : ''}`;
}
