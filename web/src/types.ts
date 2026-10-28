export type EntryKind = 'user' | 'assistant' | 'reasoning' | 'tool' | 'notice' | 'error' | 'system' | 'compaction' | 'divider';
export type ApprovalMode = 'workspace' | 'auto-review' | 'full-access';
export type { Project, ProjectCatalog } from '../../src/projects/types.js';
import type { SessionProject } from '../../src/projects/types.js';

import type { TurnCompletion } from '../../src/turn-types.js';

export interface Entry extends TurnCompletion {
  kind: EntryKind | string;
  text?: string;
  /** Client-only source ranges received through incremental patches. Snapshots
   * and paged history have no entrance animation. Never sent to the server. */
  streamReveal?: import('./stream-reveal.js').StreamRange[];
  command?: string;
  input?: Record<string, unknown>;
  result?: string;
  tool?: string;
  toolTitle?: string;
  running?: boolean;
  preparing?: boolean;
  tone?: 'info' | 'warn' | 'error';
  durationMs?: number;
  eventId?: string;
  turnId?: string;
  at?: number;
  imageCount?: number;
  attachments?: Array<{ id: string; name: string; mediaType: string; sizeBytes: number }>;
  source?: string;
  /**
   * Provenance for text the machinery wrote, not the conversation: the model's
   * checkpoint output is stored so the record stays complete, but the reader is
   * shown the compaction row instead of the raw summary.
   */
  internal?: 'compaction';
  /** Compaction rows carry their own state and the sizes they moved between. */
  status?: 'running' | 'done' | 'failed';
  beforeTokens?: number;
  afterTokens?: number;
}

/** Modal control-plane state: whether this machine can provision GPU work. */
export interface ModalInfo {
  configured: boolean;
  verified: boolean;
  /** Apps visible to the token, when Modal answered. */
  apps: number | null;
  error: string | null;
  /** The token id is shown back; the secret never is. */
  tokenId: string | null;
}

/** A provider the catalog knows, with whether this machine already holds a key. */
export interface ProviderCatalogRow {
  providerId: string;
  modelCount: number;
  configured: boolean;
  /** How many of this provider's models are active in the composer. */
  activeModels: number;
  /** A provider configured by hand: its models come from settings, not the catalog. */
  custom: boolean;
}

export type { ModelCatalogRow, ModelPresentation } from '../../src/provider/model-types.js';

export interface ApprovalRequest {
  id: string;
  toolName?: string;
  summary?: string;
  detail?: string;
  reason?: string;
}

export interface PendingQuestion {
  id: string;
  question?: string;
  options?: string[];
}

export interface RuntimeInfo {
  supportsSessionAttachments?: boolean;
  modelName?: string;
  /** Readable provider name; absent from an older host, so views fall back to providerId. */
  providerName?: string;
  providerId?: string;
  modelId?: string;
  contextWindowTokens?: number | null;
  approvalMode?: string | null;
  showReasoningDefault?: boolean;
  /** This provider's reasoning opens with a bold title line; group headlines may use it. */
  reasoningTitles?: boolean;
  reasoningVariants?: Array<{ id: string; label: string }>;
  reasoningDefault?: string;
  workspaceRoot?: string;
}

export interface SessionPayload {
  reset: boolean;
  entries: Entry[];
  updated: { index: number; entry: Entry }[];
  from: number;
  totalEntries: number;
  busy: boolean;
  /** The turn the running work writes into; null before a new run has placed its message and when idle. */
  runningTurnId: string | null;
  queuedMessageCount: number;
  queuedMessages?: Array<{ id?: string; text: string; imageCount: number; editable?: boolean; steering?: boolean }>;
  pendingApproval: ApprovalRequest | null;
  pendingQuestion: PendingQuestion | null;
  contextTokens?: number | null;
  runtime?: RuntimeInfo;
  session: { id: string; title: string; hasUserMessage?: boolean; project?: SessionProject; projectLocked?: boolean };
  /** Changes when the server is serving a rebuilt browser bundle. */
  buildId?: string | null;
}

export interface SessionInfo {
  running?: boolean;
  id: string;
  title: string;
  updatedAt?: number | string;
  preview?: string | null;
  workspaceRoot?: string;
}

export type { ModelPresentation as ModelChoice } from '../../src/provider/model-types.js';

export interface DraftImage {
  id: string;
  name: string;
  dataUrl: string;
  base64: string;
  mediaType: 'image/png';
}

/** One local day of recorded model requests. */
export interface UsageDay {
  day: string;
  requests: number;
  freshInputTokens: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  durationMs: number;
  /** Tokens actually moved that day: fresh input, cache reads and output. */
  tokens: number;
}

export interface UsageSummary {
  days: number;
  requests: number;
  freshInputTokens: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  busiest: UsageDay | null;
  longestTaskMs: number;
  streakDays: number;
  pricedRows: number;
  unpricedRows: number;
}

export interface UsageReport {
  label: string;
  summary: UsageSummary;
  days: UsageDay[];
}

/** One local hour of recorded model requests. */
export interface UsageHour {
  hour: string;
  requests: number;
  freshInputTokens: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  durationMs: number;
}

export interface UsageHoursReport {
  label: string;
  /** Tokens in the busiest hour of the window, so a bar can be scaled. */
  peak: number;
  days: Array<{
    day: string;
    requests: number;
    tokens: number;
    costUsd: number;
    busiestHour: string | null;
    hours: Array<{ hour: string; label: string; requests: number; tokens: number; costUsd: number }>;
  }>;
}

export interface MemoryFileInfo {
  /** Path relative to the memory root. */
  name: string;
  group: 'preferences' | 'profile' | 'topics' | 'areas' | 'workspace';
  scope: string;
  title: string;
  description: string;
  updated: string;
  type: string;
  bytes: number;
  /** Markdown without frontmatter, meant to be rendered. */
  body: string;
  truncated: boolean;
}

export interface MemoryInfo {
  root: string;
  index: { name: string; present: boolean; bytes: number; lines: number };
  files: MemoryFileInfo[];
  omitted: number;
}

export interface LogRecord {
  ts: string;
  level: 'error' | 'warn' | 'info' | 'debug';
  event: string;
  [field: string]: unknown;
}

export interface AboutInfo {
  version: string;
  /** Which browser bundle this server is serving. */
  buildId: string | null;
  /** The daemon's launch entry (source tsx or built js), formatted by the server. */
  hostEntry?: string | null;
  workspace: string;
  dataDir: string;
  logPath: string;
  uptimeMs: number;
  providerId: string;
  modelId: string;
  contextWindowTokens: number | null;
}

export interface TelegramInfo {
  enabled: boolean;
  state: 'disabled' | 'connecting' | 'polling' | 'error' | 'stopped';
  paired: boolean;
  username: string | null;
  error: string | null;
}

export interface ApprovalsInfo {
  mode: ApprovalMode;
  remembered: number;
  supported: ApprovalMode[];
  /** Exact calls the owner allowed once and kept, newest first. */
  permissions: Array<{ id: string; label: string; at: number }>;
  /** Who reviews risky calls in auto-review mode; null means the conversation model. */
  autoReview: { providerId: string | null; modelId: string | null; timeoutSeconds: number | null };
  /** Active models the reviewer may be set to. */
  models: Array<{ providerId: string; modelId: string; name: string }>;
}
