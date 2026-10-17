import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { getDataPath } from './paths.js';
import { redactSensitive, redactSensitiveText } from './sensitive-data.js';
import type { ToolEffect } from './tools/registry.js';

/**
 * The action states a row may hold. The list is the single source of truth for
 * the type and for the table's CHECK constraint, so a state added here cannot
 * drift out of the schema the way a hand-written union and a hand-written
 * constraint list can.
 */
export const TOOL_ACTION_STATES = [
  'proposed',
  'reviewed',
  'review_unavailable',
  'approved',
  'denied',
  'started',
  'completed',
  'failed',
  'cancelled',
] as const;
export type ToolActionState = (typeof TOOL_ACTION_STATES)[number];

export const OBSERVED_EVENT_STATES = ['pending', 'processing', 'delivered', 'failed', 'ignored', 'interrupted'] as const;
export type ObservedEventState = (typeof OBSERVED_EVENT_STATES)[number];

/** SQL literal list for a CHECK constraint, built from the state arrays above. */
function stateCheck(column: string, states: readonly string[]): string {
  return `CHECK(${column} IN (${states.map((state) => `'${state}'`).join(',')}))`;
}

export interface ToolActionUpdate {
  requestId: string;
  workspaceRoot: string;
  sessionId: string;
  eventId?: string;
  providerId: string;
  name: string;
  input: Record<string, unknown>;
  effect: ToolEffect;
  state: ToolActionState;
  result?: unknown;
  error?: string;
}

export interface ObservedEventInput {
  source: string;
  kind: string;
  dedupeKey: string;
  workspaceRoot?: string;
  occurredAt?: string;
  payload: Record<string, unknown>;
}

export interface ObservedEventRow {
  id: string;
  source: string;
  kind: string;
  dedupeKey: string;
  workspaceRoot: string | null;
  occurredAt: string;
  receivedAt: string;
  status: ObservedEventState;
  attempts: number;
  payload: Record<string, unknown>;
  error: string | null;
}

export interface ToolActionRow {
  requestId: string;
  workspaceRoot: string;
  sessionId: string;
  eventId: string | null;
  providerId: string;
  name: string;
  state: ToolActionState;
  effect: ToolEffect;
  input: Record<string, unknown>;
  result: unknown;
  createdAt: string;
  updatedAt: string;
  error: string | null;
}

export type LedgerPruneTarget = 'events' | 'actions';

export interface AutoReviewSummary {
  reviewed: number;
  allow: number;
  deny: number;
  escalate: number;
  unavailable: number;
  unavailableByCode: Record<string, number>;
}

export interface LedgerPruneCounts {
  events: number;
  actions: number;
  transitions: number;
}

const TERMINAL_ACTION_STATES = new Set<ToolActionState>(['completed', 'failed', 'cancelled', 'denied']);
const MAX_STORED_JSON_CHARS = 32_000;

/** Table and index definitions shared by the writer and the in-memory reader. */
const LEDGER_SCHEMA = `
  CREATE TABLE IF NOT EXISTS ranite_events (
    event_id TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    kind TEXT NOT NULL,
    dedupe_key TEXT NOT NULL UNIQUE,
    workspace_root TEXT,
    occurred_at TEXT NOT NULL,
    received_at TEXT NOT NULL,
    status TEXT NOT NULL ${stateCheck('status', OBSERVED_EVENT_STATES)},
    attempts INTEGER NOT NULL DEFAULT 0,
    payload_json TEXT NOT NULL,
    error TEXT,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS ranite_events_status_received_idx ON ranite_events(status, received_at);
  CREATE TABLE IF NOT EXISTS ranite_actions (
    request_id TEXT PRIMARY KEY,
    workspace_root TEXT NOT NULL,
    session_id TEXT NOT NULL,
    event_id TEXT,
    provider_id TEXT NOT NULL,
    tool_name TEXT NOT NULL,
    state TEXT NOT NULL ${stateCheck('state', TOOL_ACTION_STATES)},
    effect_json TEXT NOT NULL,
    input_json TEXT NOT NULL,
    input_sha256 TEXT NOT NULL,
    result_json TEXT,
    error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT
  );
  CREATE INDEX IF NOT EXISTS ranite_actions_session_created_idx ON ranite_actions(session_id, created_at);
  CREATE INDEX IF NOT EXISTS ranite_actions_state_updated_idx ON ranite_actions(state, updated_at);
  CREATE TABLE IF NOT EXISTS ranite_action_transitions (
    id INTEGER PRIMARY KEY,
    request_id TEXT NOT NULL,
    state TEXT NOT NULL,
    detail_json TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS ranite_action_transitions_request_idx ON ranite_action_transitions(request_id, id);
  CREATE TABLE IF NOT EXISTS ranite_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

/**
 * Opens a reader without creating anything. A WAL database needs its
 * shared-memory sidecar, which a strictly read-only SQLite open cannot always
 * create while the host holds the database; the fallback opens normally and
 * enforces `query_only`, so the connection can still never write.
 */
function openReadOnlyLedger(path: string): DatabaseSync {
  if (path !== ':memory:' && !existsSync(path)) {
    const memory = new DatabaseSync(':memory:');
    memory.exec(LEDGER_SCHEMA);
    return memory;
  }
  try {
    const reader = new DatabaseSync(path, { readOnly: true });
    reader.exec('PRAGMA busy_timeout = 5000;');
    return reader;
  } catch {
    const reader = new DatabaseSync(path);
    reader.exec('PRAGMA busy_timeout = 5000; PRAGMA query_only = ON;');
    return reader;
  }
}

export class ActivityLedger {
  private readonly database: DatabaseSync;
  private closed = false;

  constructor(path = getDataPath('state.db'), options: { readOnly?: boolean } = {}) {
    if (options.readOnly) {
      this.database = openReadOnlyLedger(path);
      return;
    }
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    if (process.platform !== 'win32' && path !== ':memory:') {
      try {
        chmodSync(dirname(path), 0o700);
      } catch {
        /* directory permissions remain owned by the user */
      }
    }
    this.database = new DatabaseSync(path);
    this.database.exec(`
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      ${LEDGER_SCHEMA}
    `);
    const actionColumns = this.database.prepare('PRAGMA table_info(ranite_actions)').all() as unknown as Array<{ name: string }>;
    if (!actionColumns.some((column) => column.name === 'event_id'))
      this.database.exec('ALTER TABLE ranite_actions ADD COLUMN event_id TEXT');
    try {
      chmodSync(path, 0o600);
    } catch {
      /* Windows applies file permissions through the user profile ACL. */
    }
  }

  recordToolAction(action: ToolActionUpdate): void {
    this.assertOpen();
    const now = new Date().toISOString();
    const safeInput = safeJson(action.input);
    const inputHash = createHash('sha256').update(JSON.stringify(action.input)).digest('hex');
    const safeResult = action.result === undefined ? null : safeJson(action.result);
    const completedAt = TERMINAL_ACTION_STATES.has(action.state) ? now : null;

    this.database.exec('BEGIN IMMEDIATE');
    try {
      if (action.state === 'proposed') {
        const inserted = this.database
          .prepare(
            `
        INSERT INTO ranite_actions (
          request_id, workspace_root, session_id, event_id, provider_id, tool_name, state,
          effect_json, input_json, input_sha256, result_json, error,
          created_at, updated_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(request_id) DO NOTHING
        `,
          )
          .run(
            action.requestId,
            action.workspaceRoot,
            action.sessionId,
            action.eventId ?? null,
            action.providerId,
            action.name,
            action.state,
            JSON.stringify(action.effect),
            safeInput,
            inputHash,
            safeResult,
            action.error === undefined ? null : redactSensitiveText(action.error),
            now,
            now,
            completedAt,
          );
        if (Number(inserted.changes) === 0) {
          this.database.exec('COMMIT');
          return;
        }
      } else {
        const updated = this.database
          .prepare(
            `
          UPDATE ranite_actions
          SET state = ?, result_json = COALESCE(?, result_json), error = ?, updated_at = ?, completed_at = COALESCE(?, completed_at)
          WHERE request_id = ?
        `,
          )
          .run(
            action.state,
            safeResult,
            action.error === undefined ? null : redactSensitiveText(action.error),
            now,
            completedAt,
            action.requestId,
          );
        if (Number(updated.changes) === 0) throw new Error('An action must be recorded before execution.');
      }
      this.database
        .prepare('INSERT INTO ranite_action_transitions (request_id, state, detail_json, created_at) VALUES (?, ?, ?, ?)')
        .run(action.requestId, action.state, safeResult ?? (action.error === undefined ? null : safeJson({ error: action.error })), now);
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  insertEvent(event: ObservedEventInput): { id: string; inserted: boolean } {
    this.assertOpen();
    validateEvent(event);
    const id = randomUUID();
    const now = new Date().toISOString();
    const occurredAt = event.occurredAt ?? now;
    const payload = JSON.stringify(event.payload);
    const payloadLimit = event.source === 'notification' ? 32 * 1024 * 1024 : 256 * 1024;
    if (Buffer.byteLength(payload, 'utf8') > payloadLimit) throw new Error('Observed event payload exceeded its size limit.');
    const result = this.database
      .prepare(
        `
      INSERT INTO ranite_events (
        event_id, source, kind, dedupe_key, workspace_root, occurred_at, received_at,
        status, attempts, payload_json, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)
      ON CONFLICT(dedupe_key) DO NOTHING
    `,
      )
      .run(id, event.source, event.kind, event.dedupeKey, event.workspaceRoot ?? null, occurredAt, now, payload, now);
    if (Number(result.changes) > 0) return { id, inserted: true };
    const existing = this.database.prepare('SELECT event_id FROM ranite_events WHERE dedupe_key = ?').get(event.dedupeKey) as
      { event_id: string } | undefined;
    return { id: existing?.event_id ?? id, inserted: false };
  }

  claimEvent(id: string): ObservedEventRow | null {
    this.assertOpen();
    const now = new Date().toISOString();
    const transaction = this.database.prepare(`
      UPDATE ranite_events
      SET status = 'processing', attempts = attempts + 1, updated_at = ?, error = NULL
      WHERE event_id = ? AND status = 'pending'
    `);
    const result = transaction.run(now, id);
    if (Number(result.changes) === 0) return null;
    return this.getEvent(id);
  }

  recoverInterruptedEvents(): number {
    this.assertOpen();
    const now = new Date().toISOString();
    const result = this.database
      .prepare(
        `
      UPDATE ranite_events SET
        status = CASE WHEN source IN ('notification','owner-inbox') OR (source = 'telegram' AND kind LIKE 'inbox.%') THEN 'pending' ELSE 'interrupted' END,
        error = CASE WHEN source = 'owner-inbox' THEN 'Owner message is available for retry after host restart.' ELSE 'Host stopped while this event was being processed.' END,
        updated_at = ?
      WHERE status = 'processing'
        OR (source = 'owner-inbox' AND status = 'delivered'
          AND NOT EXISTS (SELECT 1 FROM ranite_state WHERE key = 'owner-inbox:reply:' || ranite_events.event_id))
    `,
      )
      .run(now);
    return Number(result.changes);
  }

  recoverInterruptedActions(): number {
    this.assertOpen();
    const now = new Date().toISOString();
    const error = 'Host stopped before recording the action outcome. Inspect the target; do not replay this action automatically.';
    // Anything that is not already terminal had an outcome the host never recorded,
    // so it is left failed rather than resumable. Derived from the terminal set so a
    // state added later is covered without editing this query.
    const unresolved = [...TOOL_ACTION_STATES]
      .filter((state) => !TERMINAL_ACTION_STATES.has(state))
      .map((state) => `'${state}'`)
      .join(',');
    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.database
        .prepare(
          `INSERT INTO ranite_action_transitions (request_id, state, detail_json, created_at) SELECT request_id, 'failed', ?, ? FROM ranite_actions WHERE state IN (${unresolved})`,
        )
        .run(JSON.stringify({ error }), now);
      const result = this.database
        .prepare(`UPDATE ranite_actions SET state = 'failed', error = ?, updated_at = ?, completed_at = ? WHERE state IN (${unresolved})`)
        .run(error, now, now);
      this.database.exec('COMMIT');
      return Number(result.changes);
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  setEventState(id: string, state: ObservedEventState, error?: string): void {
    this.assertOpen();
    this.database
      .prepare('UPDATE ranite_events SET status = ?, error = ?, updated_at = ? WHERE event_id = ?')
      .run(state, error === undefined ? null : redactSensitiveText(error), new Date().toISOString(), id);
  }

  retryEvent(id: string): boolean {
    this.assertOpen();
    const result = this.database
      .prepare(
        `
      UPDATE ranite_events SET status = 'pending', error = NULL, updated_at = ?
      WHERE event_id = ? AND status IN ('failed','interrupted')
    `,
      )
      .run(new Date().toISOString(), id);
    return Number(result.changes) > 0;
  }

  getEvent(id: string): ObservedEventRow | null {
    this.assertOpen();
    const row = this.database.prepare('SELECT * FROM ranite_events WHERE event_id = ?').get(id) as EventDbRow | undefined;
    return row ? eventFromRow(row) : null;
  }

  listEvents(limit = 30): ObservedEventRow[] {
    this.assertOpen();
    if (!this.database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'ranite_events'").get()) return [];
    const bounded = Math.max(1, Math.min(200, Math.trunc(limit)));
    const rows = this.database
      .prepare('SELECT * FROM ranite_events ORDER BY received_at DESC LIMIT ?')
      .all(bounded) as unknown as EventDbRow[];
    return rows.map(eventFromRow);
  }

  pendingEvents(limit = 100): ObservedEventRow[] {
    this.assertOpen();
    const rows = this.database
      .prepare(
        "SELECT * FROM ranite_events WHERE status = 'pending' AND source != 'owner-inbox' ORDER BY CASE source WHEN 'telegram' THEN 0 WHEN 'notification' THEN 1 ELSE 2 END, received_at, rowid LIMIT ?",
      )
      .all(Math.max(1, Math.min(1000, Math.trunc(limit)))) as unknown as EventDbRow[];
    return rows.map(eventFromRow);
  }

  ownerInboxEvents(limit = 10): ObservedEventRow[] {
    this.assertOpen();
    const rows = this.database
      .prepare(
        "SELECT * FROM ranite_events WHERE source = 'owner-inbox' AND status IN ('pending','failed','interrupted') ORDER BY received_at, rowid LIMIT ?",
      )
      .all(Math.max(1, Math.min(1000, Math.trunc(limit)))) as unknown as EventDbRow[];
    return rows.map(eventFromRow);
  }

  /** Newest-first events of one schedule, for run history. Reads the payload, never the transcript. */
  scheduleEvents(scheduleId: string, limit = 50): ObservedEventRow[] {
    this.assertOpen();
    const rows = this.database
      .prepare(
        "SELECT * FROM ranite_events WHERE COALESCE(json_extract(payload_json, '$.scheduleId'), json_extract(payload_json, '$.taskId')) = ? ORDER BY received_at DESC, rowid DESC LIMIT ?",
      )
      .all(scheduleId, Math.max(1, Math.min(200, Math.trunc(limit)))) as unknown as EventDbRow[];
    return rows.map(eventFromRow);
  }

  getState(key: string): string | null {
    this.assertOpen();
    const row = this.database.prepare('SELECT value FROM ranite_state WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  setState(key: string, value: string): void {
    this.assertOpen();
    this.database
      .prepare('INSERT INTO ranite_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, value);
  }

  listActions(limit = 30): ToolActionRow[] {
    this.assertOpen();
    if (!this.database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'ranite_actions'").get()) return [];
    const bounded = Math.max(1, Math.min(200, Math.trunc(limit)));
    const rows = this.database
      .prepare('SELECT * FROM ranite_actions ORDER BY created_at DESC LIMIT ?')
      .all(bounded) as unknown as ActionDbRow[];
    return rows.map(actionFromRow);
  }

  actionTransitions(requestId: string): Array<{ state: ToolActionState; detail: unknown; createdAt: string }> {
    this.assertOpen();
    const rows = this.database
      .prepare('SELECT state, detail_json, created_at FROM ranite_action_transitions WHERE request_id = ? ORDER BY id')
      .all(requestId) as unknown as Array<{ state: ToolActionState; detail_json: string | null; created_at: string }>;
    return rows.map((row) => ({
      state: row.state,
      detail: row.detail_json === null ? null : parseJson(row.detail_json),
      createdAt: row.created_at,
    }));
  }

  /**
   * Aggregates recorded auto-review verdicts so the mode can be inspected in
   * production: how often it decided, how the decisions split, and — when it
   * could not decide — why, by the machine-readable code. Reads only the
   * annotation transitions, never the conversation.
   */
  autoReviewSummary(limit = 5_000): AutoReviewSummary {
    this.assertOpen();
    const summary: AutoReviewSummary = { reviewed: 0, allow: 0, deny: 0, escalate: 0, unavailable: 0, unavailableByCode: {} };
    if (!this.database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'ranite_action_transitions'").get())
      return summary;
    const bounded = Math.max(1, Math.min(50_000, Math.trunc(limit)));
    const rows = this.database
      .prepare(
        `SELECT state, detail_json FROM ranite_action_transitions
         WHERE state IN ('reviewed', 'review_unavailable') ORDER BY id DESC LIMIT ?`,
      )
      .all(bounded) as unknown as Array<{ state: ToolActionState; detail_json: string | null }>;
    for (const row of rows) {
      const detail = row.detail_json === null ? null : parseJson(row.detail_json);
      const record = detail !== null && typeof detail === 'object' ? (detail as Record<string, unknown>) : {};
      if (row.state === 'reviewed') {
        summary.reviewed += 1;
        const verdict = record.verdict;
        if (verdict === 'allow' || verdict === 'deny' || verdict === 'escalate') summary[verdict] += 1;
      } else {
        summary.unavailable += 1;
        const code = typeof record.code === 'string' ? record.code : 'unknown';
        summary.unavailableByCode[code] = (summary.unavailableByCode[code] ?? 0) + 1;
      }
    }
    return summary;
  }

  /** Counts what an explicit prune would remove, without writing anything. */
  previewPruneBefore(cutoffIso: string, target: LedgerPruneTarget): LedgerPruneCounts {
    this.assertOpen();
    return target === 'events'
      ? { events: this.count('SELECT COUNT(*) AS count FROM ranite_events WHERE received_at < ?', cutoffIso), actions: 0, transitions: 0 }
      : {
          events: 0,
          actions: this.count('SELECT COUNT(*) AS count FROM ranite_actions WHERE created_at < ?', cutoffIso),
          transitions: this.count(
            `SELECT COUNT(*) AS count FROM ranite_action_transitions
             WHERE created_at < ? OR request_id IN (SELECT request_id FROM ranite_actions WHERE created_at < ?)`,
            cutoffIso,
            cutoffIso,
          ),
        };
  }

  /** Removes records older than the cutoff. Only explicit user pruning calls this. */
  pruneBefore(cutoffIso: string, target: LedgerPruneTarget): LedgerPruneCounts {
    this.assertOpen();
    if (target === 'events') {
      return { events: this.remove('DELETE FROM ranite_events WHERE received_at < ?', cutoffIso), actions: 0, transitions: 0 };
    }
    const transitions = this.remove(
      `DELETE FROM ranite_action_transitions
       WHERE created_at < ? OR request_id IN (SELECT request_id FROM ranite_actions WHERE created_at < ?)`,
      cutoffIso,
      cutoffIso,
    );
    const actions = this.remove('DELETE FROM ranite_actions WHERE created_at < ?', cutoffIso);
    return { events: 0, actions, transitions };
  }

  private count(sql: string, ...parameters: Array<string | number>): number {
    const row = this.database.prepare(sql).get(...parameters) as { count?: number } | undefined;
    return Number(row?.count ?? 0);
  }

  private remove(sql: string, ...parameters: Array<string | number>): number {
    return Number(this.database.prepare(sql).run(...parameters).changes);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.database.close();
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('The Ranite activity ledger is closed.');
  }
}

interface EventDbRow {
  event_id: string;
  source: string;
  kind: string;
  dedupe_key: string;
  workspace_root: string | null;
  occurred_at: string;
  received_at: string;
  status: ObservedEventState;
  attempts: number;
  payload_json: string;
  error: string | null;
}

interface ActionDbRow {
  request_id: string;
  workspace_root: string;
  session_id: string;
  event_id: string | null;
  provider_id: string;
  tool_name: string;
  state: ToolActionState;
  effect_json: string;
  input_json: string;
  result_json: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

function eventFromRow(row: EventDbRow): ObservedEventRow {
  return {
    id: row.event_id,
    source: row.source,
    kind: row.kind,
    dedupeKey: row.dedupe_key,
    workspaceRoot: row.workspace_root,
    occurredAt: row.occurred_at,
    receivedAt: row.received_at,
    status: row.status,
    attempts: row.attempts,
    payload: parseRecord(row.payload_json),
    error: row.error,
  };
}

function actionFromRow(row: ActionDbRow): ToolActionRow {
  return {
    requestId: row.request_id,
    workspaceRoot: row.workspace_root,
    sessionId: row.session_id,
    eventId: row.event_id,
    providerId: row.provider_id,
    name: row.tool_name,
    state: row.state,
    effect: parseEffect(row.effect_json),
    input: parseRecord(row.input_json),
    result: row.result_json === null ? null : parseJson(row.result_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    error: row.error,
  };
}

function safeJson(value: unknown): string {
  let safe: unknown;
  try {
    safe = redactSensitive(value);
  } catch {
    safe = '[unserializable]';
  }
  let serialized = JSON.stringify(safe);
  if (serialized === undefined) serialized = 'null';
  return serialized.length <= MAX_STORED_JSON_CHARS
    ? serialized
    : JSON.stringify({ status: 'truncated', preview: serialized.slice(0, MAX_STORED_JSON_CHARS), originalChars: serialized.length });
}

function parseRecord(value: string): Record<string, unknown> {
  const parsed = parseJson(value);
  return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
}

function parseEffect(value: string): ToolEffect {
  return parseRecord(value) as unknown as ToolEffect;
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function validateEvent(event: ObservedEventInput): void {
  for (const [label, value, max] of [
    ['source', event.source, 64],
    ['kind', event.kind, 128],
    ['dedupeKey', event.dedupeKey, 512],
  ] as const) {
    if (!value || value.length > max) throw new Error(`Observed event ${label} must be 1-${max} characters.`);
  }
  if (event.workspaceRoot !== undefined && event.workspaceRoot.length > 32_768)
    throw new Error('Observed event workspace root is too long.');
}
