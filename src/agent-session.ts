import { randomUUID } from 'node:crypto';
import { sessionFilePath } from './session-paths.js';
import { bindSessionKeyRotation, RETRY_DELAYS_MS, type RetryEvent } from './provider/retry.js';
import type { JSONValue, LanguageModel, ModelMessage } from 'ai';
import type { CompactionResult } from './compaction.js';
import type { ToolActionUpdate } from './activity-ledger.js';
import type { StepUsageReport } from './agent.js';
import type { UsageRecordInput } from './usage/recorder.js';
import {
  createSession,
  listSavedSessions,
  loadSavedSession,
  saveSession,
  sessionTitle,
  type SavedSession,
  type SessionEntry,
  type SessionEntryMeta,
  type SessionSummary,
  type NoticeTone,
} from './session-store.js';
import { isToolRequestWhitelisted, rememberToolRequest } from './tool-permissions.js';
import { ensureHostOwnedRoots } from './host-owned-paths.js';
import { consumeApproval, recordDeniedAction } from './review-overrides.js';
import type { ReasoningSupport, ReasoningVariant } from './provider/registry.js';
import { geminiToolSchemaSanitizer } from './provider/gemini-schema.js';
import { isProviderCommand, runProviderCommand } from './provider/provider-command.js';
import { loadSettings, type ApprovalMode } from './settings.js';
import { autoReviewFingerprint, reviewToolRequest, type AutoReviewOptions, type AutoReviewResult } from './auto-review.js';
import type { ToolApprovalOutcome, ToolCallRequest, ToolRegistry, ToolUserQuestion } from './tools/registry.js';
import { ToolInputPreview } from './tool-preview.js';
import { classifySensitiveEntry, redactSensitive, redactSensitiveText } from './sensitive-data.js';
import { toolDisplayCommand as displayToolCommand } from './tool-display.js';
import { reportSessionActivity } from './session-registry.js';
import { sameReplyRoute, type TurnCommunication } from './communication.js';
import { isUnsupportedImageInputError, omitUnsupportedImageInputs } from './image.js';
import { attachmentReferences, storeAttachment, type FileAttachment } from './attachments.js';
import { decodeBase64Image, MAX_IMAGE_BYTES } from './image-data.js';
import type { ProjectContext } from './projects/types.js';
import { projectFolder, sessionProject, ProjectInputError } from './projects/store.js';

export type AgentProviderOptions = Record<string, Record<string, JSONValue>>;
export type ApprovalDecision = 'allow' | 'deny' | 'always';
export type AgentTurnProgress =
  | { kind: 'start' }
  | { kind: 'assistant-delta'; text: string }
  | { kind: 'tool-start'; tool: string }
  | { kind: 'tool-result'; tool: string; outcome: string };
export type AgentEventOutput = { kind: 'assistant'; text: string };
export type QueuedMessage = {
  /** Host-bound project facts, never accepted as raw IPC metadata. */
  projectContext?: ProjectContext;
  text: string;
  /** Legacy terminal wire input. Materialized to files before queue admission. */
  images: Array<{ base64: string; mediaType: 'image/png' }>;
  /** Host-owned file references, never accepted from IPC callers. */
  attachments?: FileAttachment[];
  eventId?: string;
  /** Host-only refresh at queue admission; null withdraws a stale notification. */
  beforeDelivery?: () => Promise<string | null>;
  /** Authenticated host facts, never accepted from client message payloads. */
  communication?: TurnCommunication;
  /** Host-only progress sink for transports that display a live turn. */
  onProgress?: (progress: AgentTurnProgress) => void;
  /** Host-bound filesystem and memory scope for this queued turn; never trusted from IPC input. */
  workspaceRoot?: string;
  /** Host-only trust labels for explicitly configured observer schedules; never accepted over TUI IPC. */
  reviewAuthorization?: { kind: 'schedule'; name: string; instruction: string; triggerFacts: unknown };
};

export interface AgentSessionRuntimeView {
  supportsSessionAttachments?: boolean;
  supportsProjects?: boolean;
  workspaceRoot: string;
  modelName: string;
  providerId: string;
  modelId: string;
  contextWindowTokens: number | null;
  supportsVision: boolean;
  reasoningVariants: ReasoningVariant[];
  reasoningMetadataSource: string | null;
  reasoningSupport: ReasoningSupport;
  reasoningDefault: string;
  saveReasoningPreference: (variantId: string) => void;
  showReasoningDefault: boolean;
  saveShowReasoningPreference: (visible: boolean) => void;
  /** Receives provider retry and key-rotation events; set per run, cleared after. */
  reportRetry?: (handler: ((event: RetryEvent) => void) | null) => void;
  approvalMode?: ApprovalMode;
  saveApprovalModePreference?: (mode: ApprovalMode) => void;
}

export interface AgentEnvironment extends AgentSessionRuntimeView {
  model: LanguageModel;
  /** Model the permission reviewer runs on; unset means the main model. */
  reviewModel?: LanguageModel;
  outputLimitTokens: number | null;
  supportsImageToolResult: boolean;
  disableImageInput?: () => void;
  getReasoningProviderOptions: (variantId: string, visible: boolean) => ReasoningVariant['providerOptions'];
  /** Cheapest expressible reasoning options for permission reviews; live with model switches. */
  getReviewProviderOptions: () => ReasoningVariant['providerOptions'];
  registry: ToolRegistry;
  getPeerCapabilities?: () => { platform: string; mcpServers: Array<{ name: string; toolCount: number }>; mcpTools: string[] };
  selectWorkspaceRoot?: (workspaceRoot: string) => Promise<void>;
  /** Accounting sink; absent when nothing owns a ledger (tests, one-off runs). */
  recordUsage?: (input: UsageRecordInput, id: string) => void;

  selectModel: (providerId: string, modelId: string) => Promise<void>;
  /** Connect deferred tools before capturing the first turn's tool catalogue. */
  prepareForTurn?: () => Promise<void>;
  /** Refresh model credentials/options at request boundaries; reconnect tools only when all shared sessions are idle. */
  reloadSettings?: (reloadTools?: boolean) => Promise<void>;
  close: () => Promise<void>;
}

export type AgentSessionView = Omit<SavedSession, 'conversation' | 'conversationArchive'>;

export interface AgentSessionSnapshot {
  session: AgentSessionView;
  busy: boolean;
  pendingApproval: ToolCallRequest | null;
  pendingApprovalId: string | null;
  pendingQuestion: { id: string; question: string; options: string[] | null } | null;
  queuedMessageCount: number;
  firstQueuedMessage: { text: string; imageCount: number } | null;
  queuedMessages: { id?: string; text: string; imageCount: number; editable?: boolean }[];
  sessionSaveError: string | null;
  streamingAssistantEntry: SessionEntry | null;
}

export interface AgentTurnPreferences {
  reasoningVariantId: string;
  showReasoning: boolean;
}

type QueuedTurn = {
  id: string;
  automatic: boolean;
  message: QueuedMessage;
  preferences: AgentTurnPreferences;
  resolve: () => void;
  reject: (error: unknown) => void;
  /** The owner message already has a transcript entry; the turn only delivers it to the model. */
  entryAdded?: boolean;
};

export type AgentEventRunResult = { error: string | null; outputs: AgentEventOutput[]; replyHandledByEventId?: string; skipped?: boolean };

export interface AgentSessionOptions {
  onAutomaticWakeReady?: () => void;
  onSessionSaved?: (session: SavedSession) => void;
  /** Background-policy run: no interactive question channel and no tool-level self-approval. */
  background?: boolean;
  systemInstruction?: string;
  autoApprove?: (request: ToolCallRequest) => boolean;
  autoReviewer?: (options: AutoReviewOptions) => Promise<AutoReviewResult>;
  /** Worker tool set: when set, only these tool names are offered to the model in this session. */
  tools?: readonly string[];
  /** Worker write lease check (subagent sessions only): refused writes name the worker holding the file. */
  writeGuard?: (sessionId: string, path: string) => string | null;
  /** null stores a machine-wide custodian session without assigning it to one workspace. */
  sessionWorkspaceRoot?: string | null;
}

export interface AgentSessionClient {
  readonly runtime: AgentSessionRuntimeView;
  getSnapshot: () => AgentSessionSnapshot;
  /**
   * The transcript as the host sent it, without the notices this client shows on
   * its own. Index-addressed consumers (the web server's patches) must use this:
   * a local notice sits inside the merged snapshot, so indices taken from there
   * point at the wrong entries the moment one arrives or expires.
   */
  getServerEntries: () => readonly SessionEntry[];
  subscribe: (listener: () => void) => () => void;
  readonly isBusy: boolean;
  addEntry(entry: SessionEntry): void;
  approveToolCall(decision: ApprovalDecision, requestId?: string): void;
  answerQuestion(answer: string | null, questionId?: string): void;
  stop(options?: { keepQueue?: boolean; holdQueue?: boolean }): void;
  sendMessage(message: QueuedMessage, preferences: AgentTurnPreferences): Promise<void>;
  compact(preferences: AgentTurnPreferences, recovery?: boolean): Promise<void>;
  selectModel(providerId: string, modelId: string): Promise<void>;
  setApprovalMode(mode: ApprovalMode): Promise<void>;
  listSessions(): SessionSummary[] | Promise<SessionSummary[]>;
  loadSession(id: string): SavedSession | AgentSessionView | null | Promise<SavedSession | AgentSessionView | null>;
  createNewSession(projectId?: string | null): void | Promise<void>;
  selectProject?(projectId: string | null, sessionId: string): void | Promise<void>;
  manageQueuedMessage?(id: string, action: 'steer' | 'remove', sessionId: string): void | Promise<void>;
  removeReasoningEntries(): void;
  flushSave(): void | Promise<void>;
  close(): void | Promise<void>;
}

const STREAM_RENDER_INTERVAL_MS = 50;
/**
 * Shutdown waits for a run to settle, but a provider that ignores abort must not
 * be able to hold the host open: after this bound the controller still flushes
 * and closes, and the abandoned stream is left to its own abort handling.
 */
const CLOSE_IDLE_TIMEOUT_MS = 5_000;
/**
 * How long a manual approval prompt waits for a human decision when nothing
 * is configured. Expiry denies the action but never stops the run, so an
 * unattended agent keeps working instead of hanging on a prompt nobody sees.
 */
const DEFAULT_APPROVAL_TIMEOUT_SECONDS = 60;

/** Owns conversation/session state and runs independently of any terminal UI. */
export class AgentSessionController implements AgentSessionClient {
  private session: SavedSession;
  private conversation: ModelMessage[] = [];
  private conversationArchive: ModelMessage[] = [];
  /**
   * The system prompt, built once and reused byte-for-byte for the life of a
   * session so the provider's prefix cache always hits. It is rebuilt only when
   * the workspace, model, or session changes, or after a compaction (which
   * rewrites the conversation anyway).
   */
  private frozenSystem: { key: string; text: string } | null = null;
  private readonly listeners = new Set<() => void>();
  private readonly queuedMessages: QueuedTurn[] = [];
  /** Id of the user message whose turn is currently producing entries. */
  private activeTurnId: string | undefined;
  /**
   * Set by an Esc-style stop: queued messages are kept visible in the chat but
   * never start a run on their own. The next explicit send releases the hold
   * and the held messages run together with it. Plain and keepQueue stops do
   * not set this; only a stop that passes `holdQueue` does.
   */
  private queueHold = false;
  private readonly eventRunResults = new Map<string, AgentEventRunResult>();
  private activeEventOutputs: AgentEventOutput[] | null = null;
  private activeEventAssistantText = '';
  private activeTurnProgress: QueuedMessage['onProgress'];
  private readonly pendingStreamDeltas: Array<{ kind: 'assistant' | 'reasoning'; text: string; internal?: 'compaction' }> = [];
  private busy = false;
  private closed = false;
  private titleAbort: AbortController | null = null;
  /**
   * A compaction requested while a run was in flight. The run serves it at its
   * next step boundary; the run's end is only the fallback for a request that
   * arrives after the last step.
   */
  private pendingCompaction: { preferences: AgentTurnPreferences; recovery: boolean; scopeRoot?: string } | null = null;
  private pendingApproval: ToolCallRequest | null = null;
  private pendingApprovalId: string | null = null;
  private approvalResolver: ((decision: ApprovalDecision) => void) | null = null;
  private pendingQuestion: { id: string; question: string; options: string[] | null } | null = null;
  private questionResolver: ((answer: string | null) => void) | null = null;
  private autoReviewConsecutiveDenials = 0;
  private autoReviewRecentDenials: boolean[] = [];
  private readonly autoReviewDeniedFingerprints = new Map<string, string>();
  private readonly autoReviewAllowedFingerprints = new Set<string>();
  private currentReviewAuthorization: QueuedMessage['reviewAuthorization'] | null = null;
  private currentReviewMessages: ModelMessage[] = [];
  private activeRunAbort: AbortController | null = null;
  private lastContextUsage: number | undefined;
  private lastContextEstimate: number | undefined;
  private contextUsageBaseline: number | undefined;
  private contextGrowthThisTurn: number | undefined;
  private sessionHasUserMessage = false;
  private latestSessionSnapshot: SavedSession | null = null;
  private sessionSaveTimer: ReturnType<typeof setTimeout> | null = null;
  private sessionSaveError: string | null = null;
  private streamFlushTimer: ReturnType<typeof setTimeout> | null = null;
  private streamedAssistantEntry: SessionEntry | null = null;
  private streamedReasoningEntry: SessionEntry | null = null;
  /** The compaction row currently on screen, so its state can be updated in place. */
  private compactionEntry: Extract<SessionEntry, { kind: 'compaction' }> | null = null;
  /**
   * The one notice a retry sequence owns. Each further attempt replaces this
   * entry in place instead of appending a line per second, and the entry stays
   * in the transcript after the sequence ends, so a slow turn explains itself.
   */
  private retryNotice: SessionEntry | null = null;

  /** Turns a provider retry or key rotation into that single updating line. */
  private reportModelRetry(event: RetryEvent): void {
    const cause = describeRetryCause(event.error);
    const text =
      event.kind === 'retry'
        ? `${cause}. Retry ${event.attempt + 1} of ${RETRY_DELAYS_MS.length} in ${Math.max(1, Math.round(event.waitMs / 1000))}s.`
        : `${cause}. ${event.reason === 'auth' ? 'Key rejected' : 'Retries exhausted'}, switching to the next key.`;
    const next: SessionEntry = { kind: 'notice', text, tone: 'warn' };
    const previous = this.retryNotice;
    if (previous) this.replaceEntry(previous, next);
    else this.addEntry(next);
    this.retryNotice = next;
  }

  /** A response arrived, so the next retry belongs to a new line. */
  private closeRetryNotice(): void {
    this.retryNotice = null;
  }

  /** When the current reasoning block started, for the duration it reports. */
  private reasoningStartedAt: number | null = null;
  private runningToolEntry: { request: ToolCallRequest; entry: Extract<SessionEntry, { kind: 'tool' }> } | null = null;
  private readonly previewToolEntries = new Map<
    string,
    {
      entry: Extract<SessionEntry, { kind: 'tool' }>;
      preview: ToolInputPreview;
      providerId: string;
      name: string;
    }
  >();
  private snapshot: AgentSessionSnapshot;
  private activeEventId: string | undefined;
  private runError: string | null = null;
  private closePromise: Promise<void> | null = null;

  constructor(
    readonly runtime: AgentEnvironment,
    private readonly recordAction?: (action: ToolActionUpdate) => void | Promise<void>,
    private readonly options: AgentSessionOptions = {},
  ) {
    // Every session (foreground, background, worker) provisions the host-owned
    // roots first, so the dated scratch directory exists before the first
    // tool call classifies against it. Best-effort by design; see
    // ensureHostOwnedRoots.
    ensureHostOwnedRoots();
    this.session = createSession(
      runtime.providerId,
      runtime.modelId,
      runtime.contextWindowTokens ?? undefined,
      this.sessionWorkspaceScope ?? undefined,
    );
    this.lastContextUsage = this.session.contextTokens;
    this.lastContextEstimate = this.session.contextEstimateTokens;
    this.contextUsageBaseline = this.session.contextTokens;
    this.contextGrowthThisTurn = this.session.contextGrowthTokens;
    this.snapshot = this.makeSnapshot();
  }

  getSnapshot = (): AgentSessionSnapshot => this.snapshot;
  private sessionModel(model: LanguageModel = this.runtime.model): LanguageModel {
    return bindSessionKeyRotation(model, (this.session.keyPositions ??= {}));
  }
  /** The provider-boundary schema rebuild for this run's model, absent where no strict subset applies. */
  private toolSchemaSanitizer(): ((schema: Record<string, unknown>) => Record<string, unknown>) | undefined {
    return geminiToolSchemaSanitizer(this.sessionModel());
  }
  /** The controller has no client-local notices, so both views are the same. */
  getServerEntries = (): readonly SessionEntry[] => this.snapshot.session.entries;
  get isBusy(): boolean {
    return this.busy;
  }
  get automaticWakeHeld(): boolean {
    return this.session.automaticWakeHeld === true;
  }
  getLastRunError(): string | null {
    return this.runError;
  }

  takeEventRunResult(eventId: string): AgentEventRunResult | null {
    const result = this.eventRunResults.get(eventId) ?? null;
    this.eventRunResults.delete(eventId);
    return result;
  }

  private get sessionWorkspaceScope(): string | null {
    return this.options.sessionWorkspaceRoot === undefined ? this.runtime.workspaceRoot : this.options.sessionWorkspaceRoot;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private makeSnapshot(): AgentSessionSnapshot {
    // A held turn whose entry already sits in the transcript is not "queued" from
    // the owner's point of view; counting it twice would show the same text twice.
    const pending = this.queuedMessages.filter((turn) => !turn.entryAdded);
    const queuedMessages = pending.map((turn) => ({
      id: turn.id,
      text: turn.message.text,
      imageCount: messageImageCount(turn.message),
      editable: !turn.automatic,
    }));
    const first = queuedMessages[0] ?? null;
    const { conversation, conversationArchive, ...session } = this.session;
    void conversation;
    void conversationArchive;
    return {
      session: { ...session, hasUserMessage: this.sessionHasUserMessage },
      busy: this.busy,
      pendingApproval: this.pendingApproval,
      pendingApprovalId: this.pendingApprovalId,
      pendingQuestion: this.pendingQuestion,
      queuedMessageCount: pending.length,
      firstQueuedMessage: first,
      queuedMessages,
      sessionSaveError: this.sessionSaveError,
      streamingAssistantEntry: this.streamedAssistantEntry,
    };
  }

  private publish(scheduleSave = true): void {
    this.snapshot = this.makeSnapshot();
    for (const listener of this.listeners) listener();
    if (scheduleSave) this.scheduleSave();
  }

  private scheduleSave(): void {
    this.latestSessionSnapshot = this.persistableSession();
    if (!this.session.entries.some((entry) => entry.kind === 'user') || this.sessionSaveTimer !== null) return;
    this.sessionSaveTimer = setTimeout(
      () => {
        this.sessionSaveTimer = null;
        this.persistLatest();
      },
      this.busy ? 1_000 : 400,
    );
  }

  private persistableSession(): SavedSession {
    return {
      ...this.session,
      title: this.session.title === 'New session' ? sessionTitle(this.session.entries) : this.session.title,
      updatedAt: new Date().toISOString(),
      providerId: this.runtime.providerId,
      modelId: this.runtime.modelId,
      conversation: this.conversation,
      ...(this.conversationArchive.length > 0 ? { conversationArchive: this.conversationArchive } : {}),
    };
  }

  private persistLatest(allowEmpty = false): void {
    const latest = this.latestSessionSnapshot;
    if (!latest || (!allowEmpty && !latest.entries.some((entry) => entry.kind === 'user'))) return;
    try {
      this.session = saveSession(latest, { allowEmpty });
      this.options.onSessionSaved?.(this.session);
      this.sessionSaveError = null;
    } catch (error) {
      this.sessionSaveError = error instanceof Error ? error.message : String(error);
    }
    this.publish(false);
  }

  flushSave(options: { allowEmpty?: boolean } = {}): void {
    if (this.sessionSaveTimer !== null) clearTimeout(this.sessionSaveTimer);
    this.sessionSaveTimer = null;
    this.latestSessionSnapshot = this.persistableSession();
    this.persistLatest(options.allowEmpty === true);
  }

  addEntry(entry: SessionEntry): void {
    // Stamp in place: tool and streaming bookkeeping look entries up by object
    // identity, so replacing the object here would silently detach them.
    const stamped = entry as SessionEntryMeta & SessionEntry;
    if (stamped.at === undefined) stamped.at = Date.now();
    if (stamped.turnId === undefined && this.activeTurnId !== undefined) stamped.turnId = this.activeTurnId;
    this.session = { ...this.session, entries: [...this.session.entries, stamped] };
    this.publish();
  }

  private replaceEntry(previous: SessionEntry, next: SessionEntry): void {
    const index = this.session.entries.indexOf(previous);
    if (index < 0) return;
    // A replacement keeps the entry's origin: grouping and timing must not move
    // just because the row was rewritten (streaming text, tool result).
    const stamped = next as SessionEntryMeta & SessionEntry;
    if (stamped.at === undefined) stamped.at = previous.at;
    if (stamped.turnId === undefined) stamped.turnId = previous.turnId;
    const entries = [...this.session.entries];
    entries[index] = stamped;
    this.session = { ...this.session, entries };
    this.publish();
  }

  removeReasoningEntries(): void {
    for (let index = this.pendingStreamDeltas.length - 1; index >= 0; index--) {
      if (this.pendingStreamDeltas[index]?.kind === 'reasoning') this.pendingStreamDeltas.splice(index, 1);
    }
    this.streamedReasoningEntry = null;
    const entries = this.session.entries.filter((entry) => entry.kind !== 'reasoning');
    if (entries.length === this.session.entries.length) return;
    this.session = { ...this.session, entries };
    this.publish();
  }

  addNotice(text: string, tone: NoticeTone = 'info'): void {
    // Info stays unmarked so persisted transcripts keep the established shape.
    this.addEntry(tone === 'info' ? { kind: 'notice', text } : { kind: 'notice', text, tone });
  }

  listSessions(): SessionSummary[] {
    return listSavedSessions(this.sessionWorkspaceScope);
  }

  loadSession(id: string): SavedSession | null {
    const session = loadSavedSession(id, this.sessionWorkspaceScope);
    if (session) this.openSession(session);
    return session;
  }

  openSession(session: SavedSession): void {
    if (this.busy) return;
    this.flushSave();
    this.session = {
      ...session,
      keyPositions: session.keyPositions ?? {},
      ...(session.workspaceRoot === undefined && typeof this.sessionWorkspaceScope === 'string'
        ? { workspaceRoot: this.sessionWorkspaceScope }
        : {}),
    };
    this.conversation = [...session.conversation];
    this.conversationArchive = [...(session.conversationArchive ?? [])];
    this.frozenSystem = null;
    this.lastContextUsage = session.contextTokens;
    this.lastContextEstimate = session.contextEstimateTokens;
    this.contextUsageBaseline = session.contextTokens;
    this.contextGrowthThisTurn = session.contextGrowthTokens;
      entries: session.entries.map((entry) => {
        if (entry.kind !== 'tool' || entry.toolTitle !== undefined || !entry.tool) return entry;
        const title = this.runtime.registry.getDisplayTitle(entry.tool);
        return title !== undefined ? { ...entry, toolTitle: title } : entry;
      }),
    this.sessionHasUserMessage = session.entries.some((entry) => entry.kind === 'user');
    this.pendingApproval = null;
    this.pendingApprovalId = null;
    this.streamedAssistantEntry = null;
    this.streamedReasoningEntry = null;
    this.runningToolEntry = null;
    this.currentReviewAuthorization = null;
    this.currentReviewMessages = [];
    this.publish();
  }

  selectProject(projectId: string | null, sessionId: string): void {
    if (sessionId !== this.session.id) throw new ProjectInputError('The active chat changed. Try again.');
    if (this.sessionHasUserMessage || this.session.project?.locked || this.queuedMessages.some((turn) => !turn.automatic))
      throw new ProjectInputError("This chat's project was fixed by its first message. Start a new chat.");
    if (this.busy) throw new ProjectInputError('Wait for the running task to finish before choosing a project.');
    this.session = saveSession({ ...this.session, project: sessionProject(projectId) }, { allowEmpty: true });
    this.publish(false);
  }

  createNewSession(projectId?: string | null): void {
    if (this.busy) return;
    const project = projectId === undefined ? undefined : sessionProject(projectId);
    this.flushSave();
    this.session = createSession(
      this.runtime.providerId,
      this.runtime.modelId,
      this.runtime.contextWindowTokens ?? undefined,
      this.sessionWorkspaceScope ?? undefined,
    );
    if (project) this.session = saveSession({ ...this.session, project }, { allowEmpty: true });
    this.conversation = [];
    this.conversationArchive = [];
    this.frozenSystem = null;
    this.lastContextUsage = undefined;
    this.lastContextEstimate = undefined;
    this.contextUsageBaseline = undefined;
    this.contextGrowthThisTurn = undefined;
    this.sessionHasUserMessage = false;
    this.pendingApproval = null;
    this.pendingApprovalId = null;
    this.streamedAssistantEntry = null;
    this.streamedReasoningEntry = null;
    this.runningToolEntry = null;
    this.currentReviewAuthorization = null;
    this.currentReviewMessages = [];
    this.publish();
  }

  async selectModel(providerId: string, modelId: string): Promise<void> {
    if (this.busy) return;
    const sameModel = modelId === this.session.modelId;
    await this.runtime.selectModel(providerId, modelId);
    // A provider change for the same model must not replace measured usage with a smaller byte estimate.
    if (!sameModel) {
      this.lastContextUsage = undefined;
      this.lastContextEstimate = undefined;
      this.contextUsageBaseline = undefined;
      this.contextGrowthThisTurn = undefined;
    }
    this.session = {
      ...this.session,
      providerId,
      modelId,
      ...(this.runtime.contextWindowTokens === null ? {} : { contextWindowTokens: this.runtime.contextWindowTokens }),
    };
    if (!sameModel) {
      delete this.session.contextTokens;
      delete this.session.contextEstimateTokens;
      delete this.session.contextGrowthTokens;
    }
    if (this.runtime.contextWindowTokens === null) delete this.session.contextWindowTokens;
    this.publish();
  }

  async setApprovalMode(mode: ApprovalMode): Promise<void> {
    if (!this.runtime.saveApprovalModePreference) throw new Error('Permission settings are unavailable.');
    await this.runtime.saveApprovalModePreference(mode);
    this.publish();
  }

  approveToolCall(decision: ApprovalDecision, requestId = this.pendingApprovalId): void {
    if (!this.pendingApproval || !this.pendingApprovalId || requestId !== this.pendingApprovalId) return;
    const resolve = this.approvalResolver;
    const request = this.pendingApproval;
    this.approvalResolver = null;
    this.pendingApproval = null;
    this.pendingApprovalId = null;
    this.publish();
    if (!resolve || !request) return;
    if (decision !== 'deny') this.autoReviewConsecutiveDenials = 0;
    if (decision === 'always') {
      try {
        rememberToolRequest(this.runtime.workspaceRoot, request);
      } catch (error) {
        this.addNotice(
          `Could not save the allowlist; this request will be allowed once. ${error instanceof Error ? error.message : String(error)}`,
          'warn',
        );
      }
    }
    resolve(decision);
  }

  answerQuestion(answer: string | null, questionId = this.pendingQuestion?.id): void {
    if (!this.pendingQuestion || questionId !== this.pendingQuestion.id) return;
    const resolve = this.questionResolver;
    this.questionResolver = null;
    this.pendingQuestion = null;
    this.publish();
    resolve?.(answer);
  }

  /**
   * Stops the current work. By default queued messages are dropped too (a plain
   * stop); `keepQueue` keeps them and they start automatically in a fresh turn
   * (the owner's `/stop` semantics); `holdQueue` implies `keepQueue` and additionally
   * holds them back so they stay visible in the chat without starting a run on
   * their own (the TUI's Esc semantics). The hold is released by the next
   * explicit send, which runs the held messages together with the new one.
   */
  stop(options: { keepQueue?: boolean; holdQueue?: boolean; preserveWakePolicy?: boolean } = {}): void {
    if (!options.preserveWakePolicy) this.session = { ...this.session, automaticWakeHeld: true };
    if (options.holdQueue === true) {
      this.queueHold = true;
      this.materializeHeldTurns();
    } else if (options.keepQueue !== true) {
      for (const turn of this.queuedMessages.splice(0)) turn.reject(new Error('Run cancelled before execution.'));
    }
    this.activeRunAbort?.abort();
    if (this.pendingQuestion) this.answerQuestion(null);
    if (this.pendingApproval) this.approveToolCall('deny');
    else this.publish();
  }

  close(): Promise<void> {
    this.closePromise ??= this.closeSession();
    return this.closePromise;
  }

  private async closeSession(): Promise<void> {
    this.closed = true;
    this.stop({ preserveWakePolicy: true });
    this.flushStreamedEntries();
    this.flushSave();
    await this.waitUntilIdle(CLOSE_IDLE_TIMEOUT_MS);
    this.flushStreamedEntries();
    if (this.streamFlushTimer !== null) clearTimeout(this.streamFlushTimer);
    this.streamFlushTimer = null;
    this.flushSave();
  }

  waitUntilIdle(timeoutMs?: number): Promise<void> {
    if (!this.busy) return Promise.resolve();
    return new Promise((resolveIdle) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const unsubscribe = this.subscribe(() => {
        if (this.busy) return;
        if (timer !== null) clearTimeout(timer);
        unsubscribe();
        resolveIdle();
      });
      if (timeoutMs !== undefined)
        timer = setTimeout(() => {
          unsubscribe();
          resolveIdle();
        }, timeoutMs);
    });
  }

  private appendStreamedText(delta: string, internal?: 'compaction'): void {
    // Assistant text ends the thinking block, so its duration is stamped first.
    this.finishStreamedReasoning();
    // A response arrived: any retry line belongs to a finished sequence.
    this.closeRetryNotice();
    const previous = this.streamedAssistantEntry;
    // The marker belongs to the text that produced it and follows the entry as it
    // grows, so one checkpoint stays one entry from its first token to its last.
    const tag = internal ?? (previous?.kind === 'assistant' ? previous.internal : undefined);
    const marked = tag === undefined ? {} : { internal: tag };
    if (previous?.kind === 'assistant') {
      const next: SessionEntry = { kind: 'assistant', text: previous.text + delta, ...marked };
      this.streamedAssistantEntry = next;
      this.replaceEntry(previous, next);
    } else {
      const entry: SessionEntry = { kind: 'assistant', text: delta, ...marked };
      this.streamedAssistantEntry = entry;
      this.addEntry(entry);
    }
  }

  private appendStreamedReasoning(delta: string, internal?: 'compaction'): void {
    if (!delta) return;
    this.closeRetryNotice();
    const previous = this.streamedReasoningEntry;
    const tag = internal ?? (previous?.kind === 'reasoning' ? previous.internal : undefined);
    const marked = tag === undefined ? {} : { internal: tag };
    if (previous?.kind === 'reasoning') {
      const next: SessionEntry = {
        kind: 'reasoning',
        text: previous.text + delta,
        ...(previous.durationMs === undefined ? {} : { durationMs: previous.durationMs }),
        ...marked,
      };
      this.streamedReasoningEntry = next;
      this.replaceEntry(previous, next);
    } else {
      // Stamped here as well as in addEntry: this path inserts straight into the
      // list, and an entry without a turn id can only be placed by array
      // position — one misplacement and the thought lands in another turn.
      const entry = { kind: 'reasoning', text: delta, ...marked } as SessionEntryMeta & SessionEntry;
      if (entry.at === undefined) entry.at = Date.now();
      if (entry.turnId === undefined && this.activeTurnId !== undefined) entry.turnId = this.activeTurnId;
      this.streamedReasoningEntry = entry;
      this.reasoningStartedAt = Date.now();
      const assistantIndex = this.streamedAssistantEntry ? this.session.entries.indexOf(this.streamedAssistantEntry) : -1;
      const entries = [...this.session.entries];
      entries.splice(assistantIndex < 0 ? entries.length : assistantIndex, 0, entry);
      this.session = { ...this.session, entries };
      this.publish();
    }
  }

  /**
   * Stamps how long the model actually spent thinking on the current block, so
   * the transcript can say "Thought for 13.2s". Called wherever the block ends:
   * the next assistant token, a tool call, or the end of the run.
   */
  private finishStreamedReasoning(): void {
    const entry = this.streamedReasoningEntry;
    this.streamedReasoningEntry = null;
    const startedAt = this.reasoningStartedAt;
    this.reasoningStartedAt = null;
    if (entry?.kind !== 'reasoning' || startedAt === null || entry.durationMs !== undefined) return;
    const next: SessionEntry = { kind: 'reasoning', text: entry.text, durationMs: Math.max(0, Date.now() - startedAt) };
    this.replaceEntry(entry, next);
  }

  private queueStreamDelta(kind: 'assistant' | 'reasoning', text: string, internal?: 'compaction'): void {
    if (!text) return;
    const last = this.pendingStreamDeltas[this.pendingStreamDeltas.length - 1];
    // Deltas merge only within the same provenance: a checkpoint token must never
    // join the answer that follows it, or the marker would leak into the reply.
    if (last?.kind === kind && last.internal === internal) last.text += text;
    else this.pendingStreamDeltas.push({ kind, text, ...(internal === undefined ? {} : { internal }) });
    if (this.streamFlushTimer === null) {
      // A repaint batch keeps the current message open; tool/run boundaries finish it.
      this.streamFlushTimer = setTimeout(() => this.flushStreamedDeltas(), STREAM_RENDER_INTERVAL_MS);
    }
  }

  /** The admitted turn's own message preferences; cleared when the run settles. */
  private activeTurnPreferences: AgentTurnPreferences | null = null;
  private reasoningDefaultAtTurnStart = 'default';
  private showReasoningAtTurnStart = true;

  /**
   * Turn preferences as they are right now. The admitted turn's message owns
   * them; an explicit settings change made while it runs (another client's
   * save, a TUI toggle) still applies immediately by overriding them for the
   * rest of the turn instead of waiting for it to end.
   */
  private liveTurnPreferences(): AgentTurnPreferences {
    const turn = this.activeTurnPreferences;
    if (!turn)
      return {
        reasoningVariantId: this.runtime.reasoningDefault,
        showReasoning: this.runtime.showReasoningDefault,
      };
    const changed = this.runtime.reasoningDefault !== this.reasoningDefaultAtTurnStart;
    const visibilityChanged = this.runtime.showReasoningDefault !== this.showReasoningAtTurnStart;
    return {
      reasoningVariantId: changed ? this.runtime.reasoningDefault : turn.reasoningVariantId,
      showReasoning: visibilityChanged ? this.runtime.showReasoningDefault : turn.showReasoning,
    };
  }

  /**
   * The session's frozen system prompt, built on first use and reused verbatim
   * afterwards. The cache key covers the three things a rebuild is mandatory
   * for; a compaction clears the cache so the next turn picks up fresh context.
   */
  private frozenSystemPrompt(build: (workspaceRoot: string, systemInstruction?: string) => string): string {
    const key = `${this.runtime.workspaceRoot}\u0000${this.runtime.providerId}\u0000${this.runtime.modelId}\u0000${this.session.id}`;
    if (this.frozenSystem?.key !== key) {
      this.frozenSystem = { key, text: build(this.runtime.workspaceRoot, this.options.systemInstruction) };
    }
    return this.frozenSystem.text;
  }

  private flushStreamedDeltas(): void {
    if (this.streamFlushTimer !== null) clearTimeout(this.streamFlushTimer);
    this.streamFlushTimer = null;
    for (const delta of this.pendingStreamDeltas.splice(0)) {
      if (delta.kind === 'assistant') this.appendStreamedText(delta.text, delta.internal);
      else this.appendStreamedReasoning(delta.text, delta.internal);
    }
  }

  private flushStreamedEntries(): void {
    this.flushStreamedDeltas();
    // A reasoning block usually ends here: a tool call, a step boundary or the
    // end of the run. Its duration has to be stamped before the pointer drops,
    // otherwise every block that is not followed by assistant text keeps a bare
    // "Thought" label forever.
    this.finishStreamedReasoning();
    const wasStreaming = this.streamedAssistantEntry !== null;
    this.streamedAssistantEntry = null;
    if (wasStreaming) this.publish();
  }

  private onToolStart(request: ToolCallRequest, toolCallId?: string): void {
    this.flushEventAssistantText();
    this.flushStreamedEntries();
    const input = toolDisplayInput(request.input);
    this.reportTurnProgress({ kind: 'tool-start', tool: toolIdentity(request) });
    const tool = toolIdentity(request);
    const preview = toolCallId ? this.previewToolEntries.get(toolCallId) : undefined;
    if (preview) {
      this.previewToolEntries.delete(toolCallId!);
      const entry: Extract<SessionEntry, { kind: 'tool' }> = {
        kind: 'tool',
        input,
        result: '',
        running: true,
        tool,
        ...(request.title !== undefined ? { toolTitle: request.title } : {}),
      };
      this.runningToolEntry = { request, entry };
      this.replaceEntry(preview.entry, entry);
      return;
    }
    const entry: Extract<SessionEntry, { kind: 'tool' }> = {
      kind: 'tool',
      input,
      result: '',
      running: true,
      tool,
      ...(request.title !== undefined ? { toolTitle: request.title } : {}),
    };
    this.runningToolEntry = { request, entry };
    this.addEntry(entry);
  }

  private onToolResult(request: ToolCallRequest, value: unknown, toolCallId?: string): void {
    this.flushEventAssistantText();
    this.flushStreamedEntries();
    const formatted = formatToolResult(request, value);
    this.reportTurnProgress({ kind: 'tool-result', tool: toolIdentity(request), outcome: formatted.outcome });
    const tool = toolIdentity(request);
    const workerSession = workerSessionId(request, value);
    const running = this.runningToolEntry;
    if (running?.request === request) {
      this.runningToolEntry = null;
      this.replaceEntry(running.entry, {
        kind: 'tool',
        input: running.entry.input ?? toolDisplayInput(request.input),
        result: formatted.text || 'No output',
        running: false,
        tool,
        ...(running.entry.at === undefined ? {} : { durationMs: Date.now() - running.entry.at }),
        ...(workerSession === undefined ? {} : { session: workerSession }),
      });
      return;
    }
    const preview = toolCallId ? this.previewToolEntries.get(toolCallId) : undefined;
    if (preview) {
      this.previewToolEntries.delete(toolCallId!);
      this.replaceEntry(preview.entry, {
        kind: 'tool',
        input: toolDisplayInput(request.input),
        result: formatted.text || 'No output',
        tool,
        ...(preview.entry.at === undefined ? {} : { durationMs: Date.now() - preview.entry.at }),
        ...(workerSession === undefined ? {} : { session: workerSession }),
      });
      return;
    }
    this.addEntry({
      kind: 'tool',
      input: toolDisplayInput(request.input),
      result: formatted.text || 'No output',
      tool,
      ...(workerSession === undefined ? {} : { session: workerSession }),
    });
  }
        ...(request.title !== undefined ? { toolTitle: request.title } : {}),

  private onToolPreviewStart(info: { toolCallId: string; providerId: string; name: string }): void {
    // Commit buffered text but keep the assistant message open: providers can keep streaming text
    // after a tool call begins, and it belongs to the same message. Closing here split it in two.
    this.flushStreamedDeltas();
    const entry: Extract<SessionEntry, { kind: 'tool' }> = {
      kind: 'tool',
      command: info.title ?? toolDisplayName(info.providerId, info.name),
      ...(info.title !== undefined ? { toolTitle: info.title } : {}),
      result: '',
      preparing: true,
      tool: toolIdentity(info),
    };
    this.previewToolEntries.set(info.toolCallId, { entry, preview: new ToolInputPreview(), providerId: info.providerId, name: info.name });
        ...(request.title !== undefined ? { toolTitle: request.title } : {}),
    this.addEntry(entry);
  }

  private onToolPreviewDelta(info: { toolCallId: string; inputTextDelta: string }): void {
    const preview = this.previewToolEntries.get(info.toolCallId);
    if (!preview) return;
    preview.preview.push(info.inputTextDelta);
    const command = toolPreviewCommand(preview.providerId, preview.name, preview.preview.fields, preview.entry.toolTitle);
    const previous = preview.entry;
    if (command === previous.command) return;
      ...(request.title !== undefined ? { toolTitle: request.title } : {}),
    const entry: Extract<SessionEntry, { kind: 'tool' }> = { ...previous, command };
    preview.entry = entry;
    this.replaceEntry(previous, entry);
  }

  private onToolPreviewAvailable(info: { toolCallId: string; input: Record<string, unknown> }): void {
    const preview = this.previewToolEntries.get(info.toolCallId);
    if (!preview) return;
    const previous = preview.entry;
    const input = toolDisplayInput(info.input);
    const { command: _preview, ...rest } = previous;
    const entry: Extract<SessionEntry, { kind: 'tool' }> = { ...rest, input };
    preview.entry = entry;
    this.replaceEntry(previous, entry);
  }

  /** A call that never reached `execute` stays visible as a settled, non-running entry. */
  private settleToolPreviews(): void {
    if (this.previewToolEntries.size === 0) return;
    for (const preview of this.previewToolEntries.values()) {
      this.replaceEntry(preview.entry, {
        kind: 'tool',
        command: preview.entry.command,
        result: 'The tool call was not executed.',
        running: false,
        ...(preview.entry.tool ? { tool: preview.entry.tool } : {}),
      });
    }
    this.previewToolEntries.clear();
  }

  private async requestApproval(request: ToolCallRequest, signal?: AbortSignal): Promise<boolean | ToolApprovalOutcome> {
    if (signal?.aborted) return false;
    const approvalMode = this.runtime.approvalMode ?? 'workspace';
    if (approvalMode === 'full-access') return true;
    if (approvalMode === 'auto-review') {
      if (this.isAutoReviewCircuitOpen()) {
        this.addNotice('Auto-review paused after repeated denials. This action needs your approval.', 'warn');
        await this.recordAutoReviewState(request, 'review_unavailable', { code: 'circuit-open', status: 'circuit-open' });
        return this.requestManualApproval(request);
      }

      const fingerprint = autoReviewFingerprint(request);
      // A one-time user approval beats the same-turn denial memory: the retry
      // still goes through review, with the override visible to the reviewer.
      const override = consumeApproval(this.runtime.workspaceRoot, request);
      if (override) this.addNotice(`Retrying ${request.providerId}/${request.name} with your one-time approval…`);
      const previousDenial = !override ? this.autoReviewDeniedFingerprints.get(fingerprint) : undefined;
      if (previousDenial) {
        this.recordAutoReviewDenial(true);
        const reason = `The same exact action was already denied in this turn. Previous reason: ${previousDenial}`;
        await this.recordAutoReviewState(request, 'reviewed', {
          reviewer: 'auto-review',
          verdict: 'deny',
          confidence: 'high',
          risk: 'unknown',
          reason,
          repeated: true,
        });
        this.addNotice(`Auto-review denied a repeated tool request: ${previousDenial}`, 'warn');
        return { approved: false, source: 'auto-review', reason };
      }

      // One status row per review: it starts as "checking" and is replaced in
      // place when the review decides, so the transcript never shows a stale
      // check. Pressing it (mouse) reveals the recorded reason and assessment.
      const checking: SessionEntry = { kind: 'notice', text: `Auto-review is checking ${request.providerId}/${request.name}…` };
      this.addEntry(checking);
      const settleReviewStatus = (text: string, detail: string) => this.replaceEntry(checking, { kind: 'notice', text, detail });
      const decisionDetail = (decision: { confidence: string; risk: string; authority?: string; reason: string }) =>
        `${decision.reason}\nRisk: ${decision.risk} · Confidence: ${decision.confidence}${decision.authority ? ` · Authority: ${decision.authority}` : ''}`;
      // Read fresh so a `ranite permissions --review-timeout` change applies without a host restart.
      const reviewTimeoutSeconds = loadSettings().autoReviewTimeoutSeconds;
      // The review is a classification call: it never inherits the turn's
      // reasoning effort, so a heavy thinking setup cannot slow every
      // permission check into a timeout.
      // An identical action already allowed in this turn is not reviewed
      // again, but only when repeating it cannot change anything outside the
      // model: reads whose result stays inside the session. Anything that
      // writes, executes, or reaches another party is reviewed every time.
      const repeatableRead =
        request.effect.change === 'none' && (request.effect.outbound === 'none' || request.effect.outbound === 'model');
      if (repeatableRead && this.autoReviewAllowedFingerprints.has(fingerprint)) {
        const reason = 'The identical side-effect-free action was already allowed in this turn.';
        await this.recordAutoReviewState(request, 'reviewed', {
          reviewer: 'auto-review',
          verdict: 'allow',
          confidence: 'high',
          risk: 'low',
          reason,
          repeated: true,
        });
        settleReviewStatus(
          `Auto-review checked ${request.providerId}/${request.name}: allow · low risk`,
          `${reason}\nRisk: low · Confidence: high`,
        );
        return { approved: true, source: 'auto-review', reason, risk: 'low' };
      }
      let outcome: AutoReviewResult;
      try {
        outcome = await (this.options.autoReviewer ?? reviewToolRequest)({
          model: this.sessionModel(this.runtime.reviewModel ?? this.runtime.model),
          request,
          messages: [...this.currentReviewMessages],
          workspaceRoot: this.runtime.workspaceRoot,
          providerOptions: this.runtime.getReviewProviderOptions(),
          ...(request.gateReason ? { gateReason: request.gateReason } : {}),
          ...(override ? { userOverride: true } : {}),
          ...(reviewTimeoutSeconds === undefined ? {} : { timeoutMs: reviewTimeoutSeconds * 1000 }),
          ...(this.currentReviewAuthorization ? { authorizedSchedule: this.currentReviewAuthorization } : {}),
          ...(signal ? { signal } : {}),
        });
      } catch (error) {
        outcome = {
          status: 'unavailable',
          code: 'model-error',
          reason: `Auto-review failed: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
      if (signal?.aborted || outcome.status === 'cancelled') return false;
      if (autoReviewFingerprint(request) !== fingerprint) {
        outcome = { status: 'unavailable', code: 'changed-during-review', reason: 'The pending action changed during review.' };
      }

      if (outcome.status === 'unavailable') {
        this.recordAutoReviewDenial(false);
        const reason = String(outcome.reason).slice(0, 500);
        await this.recordAutoReviewState(request, 'review_unavailable', { reviewer: 'auto-review', code: outcome.code, reason });
        settleReviewStatus(`Auto-review checked ${request.providerId}/${request.name}: needs your approval`, `${outcome.code}: ${reason}`);
        return this.requestManualApproval(request);
      }

      const { decision } = outcome;
      await this.recordAutoReviewState(request, 'reviewed', {
        reviewer: 'auto-review',
        providerId: this.runtime.providerId,
        modelId: this.runtime.modelId,
        verdict: decision.verdict,
        confidence: decision.confidence,
        risk: decision.risk,
        authority: decision.authority,
        reason: decision.reason,
        ...(override ? { override: true } : {}),
      });
      if (decision.verdict === 'allow') {
        this.recordAutoReviewDenial(false);
        if (repeatableRead) this.autoReviewAllowedFingerprints.add(fingerprint);
        settleReviewStatus(
          `Auto-review checked ${request.providerId}/${request.name}: allow · ${decision.risk} risk`,
          decisionDetail(decision),
        );
        return { approved: true, source: 'auto-review', reason: decision.reason, risk: decision.risk };
      }
      if (decision.verdict === 'deny') {
        this.recordAutoReviewDenial(true);
        this.autoReviewDeniedFingerprints.set(fingerprint, decision.reason);
        recordDeniedAction(this.runtime.workspaceRoot, request, decision.reason);
        settleReviewStatus(`Auto-review checked ${request.providerId}/${request.name}: denied`, decisionDetail(decision));
        return { approved: false, source: 'auto-review', reason: decision.reason };
      }

      this.recordAutoReviewDenial(false);
      settleReviewStatus(`Auto-review checked ${request.providerId}/${request.name}: needs your approval`, decisionDetail(decision));
      return this.requestManualApproval(request);
    }
    return this.requestManualApproval(request);
  }

  private requestManualApproval(request: ToolCallRequest): Promise<boolean | ToolApprovalOutcome> {
    // Read fresh so a `ranite permissions --approval-timeout` change applies without a host restart.
    const timeoutSeconds = loadSettings().approvalTimeoutSeconds ?? DEFAULT_APPROVAL_TIMEOUT_SECONDS;
    return new Promise<boolean | ToolApprovalOutcome>((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        // Drop the prompt everywhere: a later click finds no pending approval and no-ops.
        this.approvalResolver = null;
        this.pendingApproval = null;
        this.pendingApprovalId = null;
        this.addNotice(`No approval decision within ${timeoutSeconds} seconds; the action was not run.`, 'warn');
        this.publish();
        resolve({
          approved: false,
          source: 'approval-timeout',
          reason: `Nobody approved or declined within ${timeoutSeconds} seconds.`,
          timeoutSeconds,
        });
      }, timeoutSeconds * 1000);
      timer.unref?.();
      this.approvalResolver = (decision) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(decision !== 'deny');
      };
      this.pendingApproval = request;
      this.pendingApprovalId = request.requestId;
      this.publish();
    });
  }

  /**
   * Presents a model question to the user and resolves with the answer, or null
   * when the question is dismissed or the run stops. Unattended runs have no
   * channel; the question tool reports that to the model instead of hanging.
   */
  private requestQuestion(question: ToolUserQuestion, signal?: AbortSignal): Promise<string | null> {
    if (this.options.background === true) return Promise.resolve(null);
    if (signal?.aborted) return Promise.resolve(null);
    return new Promise<string | null>((resolve) => {
      const id = `question-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      this.questionResolver = (answer) => resolve(answer);
      this.pendingQuestion = { id, question: question.text, options: question.options ? [...question.options] : null };
      this.publish();
    });
  }

  /**
   * Records an auto-review verdict.
   *
   * `reviewed` and `review_unavailable` annotate a pending request; they are not
   * one of the gating transitions — `proposed`, `approved`, `started` — that must
   * be durable before execution continues. So a ledger failure here is surfaced to
   * the session and the decision still proceeds. Otherwise a bookkeeping problem
   * silently becomes a denial the user never sees and never chose.
   */
  private async recordAutoReviewState(
    request: ToolCallRequest,
    state: 'reviewed' | 'review_unavailable',
    result: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.recordAction?.({
        requestId: request.requestId,
        workspaceRoot: this.runtime.workspaceRoot,
        sessionId: this.session.id,
        ...(this.activeEventId ? { eventId: this.activeEventId } : {}),
        providerId: request.providerId,
        name: request.name,
        input: request.input,
        effect: request.effect,
        state,
        result,
      });
    } catch (error) {
      this.addNotice(
        `The activity ledger could not record the auto-review verdict (${state}): ${error instanceof Error ? error.message : String(error)}`,
        'warn',
      );
    }
  }

  private recordAutoReviewDenial(denied: boolean): void {
    this.autoReviewRecentDenials.push(denied);
    if (this.autoReviewRecentDenials.length > 50) this.autoReviewRecentDenials.shift();
    this.autoReviewConsecutiveDenials = denied ? this.autoReviewConsecutiveDenials + 1 : 0;
  }

  private isAutoReviewCircuitOpen(): boolean {
    return this.autoReviewConsecutiveDenials >= 3 || this.autoReviewRecentDenials.filter(Boolean).length >= 10;
  }

  private resetAutoReviewTurn(): void {
    this.autoReviewConsecutiveDenials = 0;
    this.autoReviewRecentDenials = [];
    this.autoReviewDeniedFingerprints.clear();
    this.autoReviewAllowedFingerprints.clear();
  }

  private reportTurnProgress(progress: AgentTurnProgress): void {
    try {
      this.activeTurnProgress?.(progress);
    } catch {
      // A transport preview must never interrupt the agent turn.
    }
  }

  private flushEventAssistantText(): void {
    const text = this.activeEventAssistantText;
    this.activeEventAssistantText = '';
    if (text.trim()) this.activeEventOutputs?.push({ kind: 'assistant', text });
  }

  /**
   * An Esc hold keeps the queued owner messages pending, but the owner expects to
   * see them in the transcript right away. Materialise each one exactly once: the
   * entry appears in the chat, while the turn still waits for the next explicit
   * send before it reaches the model.
   */
  private materializeHeldTurns(): void {
    let added = false;
    for (const turn of this.queuedMessages) {
      if (turn.automatic || turn.entryAdded) continue;
      turn.entryAdded = true;
      this.addUserEntry(turn.message);
      added = true;
    }
    if (added) this.publish();
  }

  private addUserEntry(message: QueuedMessage): void {
    this.activeTurnId = randomUUID();
    this.addEntry({
      kind: 'user',
      text: message.text,
      ...(message.workspaceRoot ? { workspaceRoot: message.workspaceRoot } : {}),
      ...(messageImageCount(message) > 0 ? { imageCount: messageImageCount(message) } : {}),
      ...(message.attachments?.length ? { attachments: message.attachments } : {}),
      ...(message.communication ? { source: message.communication.source } : {}),
      ...(message.eventId ? { eventId: message.eventId } : {}),
    });
  }

  sendMessage(message: QueuedMessage, preferences: AgentTurnPreferences): Promise<void> {
    return this.enqueueMessage(message, preferences, false);
  }

  /** Automatic wake-ups share the normal queue but never release an owner's stop. */
  sendEvent(message: QueuedMessage, preferences: AgentTurnPreferences): Promise<void> {
    if (this.closed) return Promise.reject(new Error('The target session is closed.'));
    if (this.automaticWakeHeld) return Promise.reject(new Error('Automatic wake is held by the owner.'));
    return this.enqueueMessage(message, preferences, true);
  }

  manageQueuedMessage(id: string, action: 'steer' | 'remove', sessionId: string): void {
    if (this.session.id !== sessionId) throw new Error('The active session has changed.');
    const index = this.queuedMessages.findIndex((turn) => turn.id === id && !turn.entryAdded && !turn.automatic);
    if (index < 0) throw new Error('This message is no longer queued.');
    const [turn] = this.queuedMessages.splice(index, 1);
    if (action === 'remove') turn.resolve();
    else {
      // The existing step-boundary admission still enforces scope and reply routing.
      this.queuedMessages.unshift(turn);
      this.queueHold = false;
    }
    this.publish(false);
    if (action === 'steer' && !this.busy) void this.runQueuedMessages();
  }

  private enqueueMessage(message: QueuedMessage, preferences: AgentTurnPreferences, automatic: boolean): Promise<void> {
    if (this.closed) return Promise.resolve();
    const wasHeld = this.automaticWakeHeld || this.queueHold;
    if (!automatic && this.automaticWakeHeld) {
      this.session = { ...this.session, automaticWakeHeld: false };
      if (this.options.onAutomaticWakeReady) queueMicrotask(this.options.onAutomaticWakeReady);
    }
    // `/provider ...` is host configuration, not chat: consumed here so every
    // channel behaves the same and the model never interprets it. A message
    // carrying images is left alone; attachments must not vanish silently.
    if (message.images.length === 0 && isProviderCommand(message.text)) {
      return runProviderCommand(message.text).then((outcome) => this.addNotice(outcome.notice, outcome.tone));
    }
    if (message.images.length > 0) {
      message = {
        ...message,
        attachments: [
          ...(message.attachments ?? []),
          ...message.images.map((image, index) =>
            storeAttachment(
              this.session.id,
              decodeBase64Image(image.base64, image.mediaType, MAX_IMAGE_BYTES),
              `image-${index + 1}.png`,
              image.mediaType,
            ),
          ),
        ],
        images: [],
      };
    }
    if (!automatic && this.session.project) {
      const binding = this.session.project;
      const workspaceRoot = projectFolder(binding.workspaceRoot);
      const folders = binding.folders.map(projectFolder);
      message = {
        ...message,
        workspaceRoot,
        ...(binding.id && binding.name ? { projectContext: { id: binding.id, name: binding.name, folders } } : {}),
      };
      if (!binding.locked) {
        this.session = saveSession({ ...this.session, project: { ...binding, locked: true } }, { allowEmpty: true });
        this.publish(false);
      }
    }
    return new Promise<void>((resolve, reject) => {
      const turn = { id: randomUUID(), message, preferences, resolve, reject, automatic };
      if (!automatic && wasHeld) {
        const events = this.queuedMessages.filter((queued) => queued.automatic);
        const ownerMessages = this.queuedMessages.filter((queued) => !queued.automatic);
        this.queuedMessages.splice(0, this.queuedMessages.length, ...ownerMessages, turn, ...events);
      } else this.queuedMessages.push(turn);
      if (this.busy) this.publish();
      else {
        // An explicit send releases an Esc hold: held messages run together with this one.
        if (!automatic) this.queueHold = false;
        if (this.queueHold || (automatic && this.automaticWakeHeld)) return;
        void this.runQueuedMessages();
      }
    });
  }

  /** Resolve host notifications only when they are about to enter the conversation. */
  private async prepareQueuedTurn(turn: QueuedTurn, signal: AbortSignal): Promise<boolean> {
    if (!turn.message.beforeDelivery) return true;
    try {
      const text = await turn.message.beforeDelivery();
      if (signal.aborted || this.closed) throw new Error('Run cancelled before execution.');
      if (text === null) {
        if (turn.message.eventId) this.eventRunResults.set(turn.message.eventId, { error: null, outputs: [], skipped: true });
        turn.resolve();
        return false;
      }
      turn.message = { ...turn.message, text };
      return true;
    } catch (error) {
      // A notification refresh failure must not abort the owner's unrelated work.
      turn.reject(error);
      return false;
    }
  }

  private recoverFromUnsupportedImageInput(error: unknown): boolean {
    if (!isUnsupportedImageInputError(error)) return false;
    try {
      this.runtime.disableImageInput?.();
    } catch {
      // The provider-safe message projection below still prevents another image send.
    }
    this.runtime.supportsVision = false;
    const original = this.conversation;
    const stripped = omitUnsupportedImageInputs(original);
    if (stripped.changed) {
      if (this.conversationArchive.length === 0) this.conversationArchive = [...original];
      this.conversation = stripped.messages;
      this.publish();
    }
    return true;
  }

  private async runQueuedMessages(): Promise<void> {
    if (this.closed || this.busy) return;
    const initialTurn = this.queuedMessages.shift();
    if (!initialTurn) return;
    const abortController = new AbortController();
    this.runError = null;
    this.activeRunAbort = abortController;
    this.busy = true;
    reportSessionActivity(this.session.id, true);
    this.publish();
    let activeTurn: QueuedTurn | null = initialTurn;
    let steeredTurns: QueuedTurn[] = [];
    const settleSteeredTurns = (ownerEventId: string | undefined) => {
      for (const turn of steeredTurns.splice(0)) {
        if (turn.message.eventId)
          this.eventRunResults.set(turn.message.eventId, {
            error: this.runError,
            outputs: [],
            ...(ownerEventId ? { replyHandledByEventId: ownerEventId } : {}),
          });
        turn.resolve();
      }
    };

    try {
      const [{ runAgent, buildAgentSystem }, { compactConversation }] = await Promise.all([
        import('./agent.js'),
        import('./compaction.js'),
      ]);
      let nextTurn: QueuedTurn | null = initialTurn;
      while (nextTurn) {
        const currentTurn = nextTurn;
        activeTurn = currentTurn;
        if (!(await this.prepareQueuedTurn(currentTurn, abortController.signal))) {
          activeTurn = null;
          if (abortController.signal.aborted) break;
          nextTurn = this.queuedMessages.shift() ?? null;
          continue;
        }
        // The admitted turn's own message preferences govern it; the runtime
        // defaults only matter when an explicit settings change lands mid-run.
        this.activeTurnPreferences = currentTurn.preferences;
        this.reasoningDefaultAtTurnStart = this.runtime.reasoningDefault;
        this.showReasoningAtTurnStart = this.runtime.showReasoningDefault;
        const current = currentTurn.message;
        this.resetAutoReviewTurn();
        this.runError = null;
        this.activeEventOutputs = [];
        this.activeEventAssistantText = '';
        steeredTurns = [];
        this.activeTurnProgress = current.onProgress;
        if (current.workspaceRoot) {
          if (this.runtime.selectWorkspaceRoot) await this.runtime.selectWorkspaceRoot(current.workspaceRoot);
          else if (current.workspaceRoot !== this.runtime.workspaceRoot)
            throw new Error('This session runtime cannot change workspace scope.');
        }
        this.currentReviewAuthorization = current.reviewAuthorization ?? null;
        this.activeEventId = current.eventId;
        this.reportTurnProgress({ kind: 'start' });
        // Provider retries and key rotations belong to this turn's transcript.
        this.retryNotice = null;
        this.runtime.reportRetry?.((event) => this.reportModelRetry(event));
        let titleRequest: { sessionId: string; message: string } | null = null;
        if (!this.sessionHasUserMessage) {
          this.sessionHasUserMessage = true;
          const imageOnly = messageImageCount(current) > 0 && current.text === 'User attached image';
          const titleSeed = imageOnly ? 'Image chat' : current.text || (messageImageCount(current) > 0 ? 'Image chat' : 'New session');
          this.session = { ...this.session, title: fallbackSessionTitle(titleSeed) };
          if (current.text && !imageOnly) titleRequest = { sessionId: this.session.id, message: current.text };
          this.publish();
        }
        const userMessage = queuedUserMessageToModelMessage(current);
        const growthBeforeRun = this.contextGrowthThisTurn;
        this.contextUsageBaseline = this.lastContextUsage;
        this.contextGrowthThisTurn = undefined;
        const session = { ...this.session };
        delete session.contextGrowthTokens;
        this.session = session;
        this.publish();
        this.streamedAssistantEntry = null;
        this.streamedReasoningEntry = null;
        if (!currentTurn.entryAdded) this.addUserEntry(current);
        this.conversation.push(userMessage);
        if (this.conversationArchive.length > 0) this.conversationArchive.push(userMessage);
        const conversationAtRunStart = [...this.conversation];

        let refreshTools = false;
        let finalResponseReceived = false;
        let archivedResponseCount = 0;
        do {
          refreshTools = false;
          // Wait for an idle-time tool reconnect before capturing this turn's catalogue.
          await this.runtime.prepareForTurn?.();
          await this.runtime.reloadSettings?.();
          const schemaSanitizer = this.toolSchemaSanitizer();
          const tools = await this.runtime.registry.createModelTools({
            approve: (request, signal) => this.requestApproval(request, signal),
            approvalMode: this.runtime.approvalMode ?? 'workspace',
            autoApprove: (request) => this.options.autoApprove?.(request) ?? isToolRequestWhitelisted(this.runtime.workspaceRoot, request),
            allowToolAutoApproval: this.options.background !== true,
            ...(this.options.tools ? { allowTools: this.options.tools } : {}),
            sessionId: this.session.id,
            ...(schemaSanitizer ? { schemaSanitizer } : {}),
            ...(this.options.writeGuard ? { guardWrite: (path: string) => this.options.writeGuard!(this.session.id, path) } : {}),
            ...(this.options.background === true ? {} : { ask: (question, signal) => this.requestQuestion(question, signal) }),
            onStart: (request, toolCallId) => this.onToolStart(request, toolCallId),
            onResult: (request, result, toolCallId) => this.onToolResult(request, result, toolCallId),
            preview: {
              onStart: (info) => this.onToolPreviewStart(info),
              onDelta: (info) => this.onToolPreviewDelta(info),
              onAvailable: (info) => this.onToolPreviewAvailable(info),
            },
            onAction: (request, state, detail) =>
              this.recordAction?.({
                requestId: request.requestId,
                workspaceRoot: this.runtime.workspaceRoot,
                sessionId: this.session.id,
                ...(this.activeEventId ? { eventId: this.activeEventId } : {}),
                providerId: request.providerId,
                name: request.name,
                input: request.input,
                effect: request.effect,
                state,
                ...(detail?.result === undefined ? {} : { result: detail.result }),
                ...(detail?.error === undefined ? {} : { error: detail.error }),
              }),
            signal: abortController.signal,
          });
          let streamedTextReceived = false;
          try {
            const result = await runAgent({
              sessionId: this.session.id,
              model: this.sessionModel(),
              workspaceRoot: this.runtime.workspaceRoot,
              supportsVision: this.runtime.supportsVision,
              supportsImageToolResult: this.runtime.supportsImageToolResult,
              abortSignal: abortController.signal,
              messages: this.conversation,
              system: this.frozenSystemPrompt(buildAgentSystem),
              compactBeforeStep: async (context) => {
                this.currentReviewMessages = context.messages;
                const recentContextGrowthTokens = this.contextGrowthThisTurn ?? growthBeforeRun;
                // A compaction requested while this run was in flight is served
                // here: the previous tool batch has settled and the next model
                // request has not been sent yet, which is the safe boundary the
                // request was waiting for.
                const pendingCompaction = this.takePendingCompactionForStep();
                try {
                  const compacted = await compactConversation({
                    ...context,
                    archivePath: sessionFilePath(this.session.id),
                    model: this.sessionModel(),
                    contextWindowTokens: this.runtime.contextWindowTokens,
                    outputLimitTokens: this.runtime.outputLimitTokens,
                    ...(this.lastContextUsage !== undefined ? { previousContextTokens: this.lastContextUsage } : {}),
                    ...(this.lastContextEstimate !== undefined ? { previousContextEstimateTokens: this.lastContextEstimate } : {}),
                    ...(recentContextGrowthTokens !== undefined ? { recentContextGrowthTokens } : {}),
                    ...(pendingCompaction
                      ? {
                          force: true,
                          ...(pendingCompaction.recovery ? { recovery: true } : {}),
                          providerOptions: this.runtime.getReasoningProviderOptions(
                            pendingCompaction.preferences.reasoningVariantId,
                            pendingCompaction.preferences.showReasoning,
                          ),
                        }
                      : {}),
                    onStart: () => {
                      this.flushStreamedEntries();
                      const entry: Extract<SessionEntry, { kind: 'compaction' }> = {
              getModel: async () => {
                await this.runtime.reloadSettings?.();
                return this.sessionModel();
              },
                        kind: 'compaction',
                        status: 'running',
                        ...(this.lastContextUsage === undefined ? {} : { beforeTokens: this.lastContextUsage }),
                      };
                      this.compactionEntry = entry;
                      this.addEntry(entry);
                    },
                    onTextDelta: (delta) => this.queueStreamDelta('assistant', delta, 'compaction'),
                    onReasoningDelta: (delta) => this.queueStreamDelta('reasoning', delta, 'compaction'),
                    abortSignal: abortController.signal,
                  });
                  if (compacted) {
                    this.currentReviewMessages = compacted.messages;
                  }
                  return compacted;
                } catch (error) {
                  this.flushStreamedEntries();
                  // A compaction that stopped halfway is a fact about the context,
                  // not a silent failure: the row says so and keeps its start size.
                  const started = this.compactionEntry;
                  this.compactionEntry = null;
                  if (started) {
                    this.replaceEntry(started, {
                      kind: 'compaction',
                      status: 'failed',
                      ...(started.beforeTokens === undefined ? {} : { beforeTokens: started.beforeTokens }),
                    });
                  }
                  if (abortController.signal.aborted) throw error;
                  throw new Error(`Compaction failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
                }
              },
              onCompactionComplete: (result, generatedMessages) => {
                if (this.conversationArchive.length === 0) this.conversationArchive = [...conversationAtRunStart];
                appendUniqueQueuedMessages(this.conversationArchive, generatedMessages.slice(archivedResponseCount));
                archivedResponseCount = generatedMessages.length;
                this.applyCompaction(result);
              },
              tools: tools.tools,
              shouldStop: tools.shouldStop,
              takeQueuedMessages: async () => {
                // Steering is admitted only at SDK prepareStep, after the prior tool batch.
                // Scope/route changes remain FIFO followups so they cannot borrow an active binding.
                // Owner-inbox and team signals carry no owner reply binding, so they steer any live run.
                // Drain every compatible queued message so a burst of user input all lands in the same gap.
                const admitted: ReturnType<typeof queuedUserMessageToModelMessage>[] = [];
                for (;;) {
                  const next = this.queuedMessages[0];
                  const live = this.liveTurnPreferences();
                  if (
                    (this.options.sessionWorkspaceRoot !== null &&
                      next?.message.communication?.source !== 'inbox' &&
                      next?.message.communication?.source !== 'worker') ||
                    !next ||
                    (next.message.communication?.source !== 'inbox' &&
                      next.message.communication?.source !== 'owner-inbox' &&
                      next.message.communication?.source !== 'team' &&
                      next.message.communication?.source !== 'worker' &&
                      !sameReplyRoute(current.communication?.replyTo, next.message.communication?.replyTo)) ||
                    (next.message.workspaceRoot ?? this.runtime.workspaceRoot) !== (current.workspaceRoot ?? this.runtime.workspaceRoot) ||
                    next.message.projectContext?.id !== current.projectContext?.id ||
                    next.preferences.reasoningVariantId !== live.reasoningVariantId ||
                    next.preferences.showReasoning !== live.showReasoning
                  )
                    break;
                  this.queuedMessages.shift();
                  if (!(await this.prepareQueuedTurn(next, abortController.signal))) {
                    if (abortController.signal.aborted) break;
                    continue;
                  }
                  this.flushStreamedEntries();
                  this.flushEventAssistantText();
                  if (!next.entryAdded) this.addUserEntry(next.message);
                  steeredTurns.push(next);
                  admitted.push(queuedUserMessageToModelMessage(next.message));
                }
                return admitted;
              },
              getProviderOptions: () => {
                const live = this.liveTurnPreferences();
                return this.runtime.getReasoningProviderOptions(live.reasoningVariantId, live.showReasoning);
              },
              onTextDelta: (delta) => {
                streamedTextReceived = true;
                this.activeEventAssistantText += delta;
                this.reportTurnProgress({ kind: 'assistant-delta', text: delta });
                this.queueStreamDelta('assistant', delta);
              },
              onReasoningDelta: (delta) => this.queueStreamDelta('reasoning', delta),
              onConversationProgress: (conversation, responseMessages) => {
                this.conversation = conversation;
                if (this.conversationArchive.length > 0) {
                  this.conversationArchive.push(...responseMessages.slice(archivedResponseCount));
                  archivedResponseCount = responseMessages.length;
                }
              },
              onContextUsage: (inputTokens, contextEstimateTokens) => this.onContextUsage(inputTokens, contextEstimateTokens),
              onStepUsage: (report) => this.onStepUsage(report),
            });
            this.flushStreamedEntries();
            finalResponseReceived = Boolean(result.finalText.trim());
            if (abortController.signal.aborted) {
              break;
            }
            if (result.conversation) this.conversation = result.conversation;
            else appendUniqueQueuedMessages(this.conversation, result.response.messages);
            if (this.conversationArchive.length > 0) {
              appendUniqueQueuedMessages(this.conversationArchive, result.response.messages.slice(archivedResponseCount));
            }
            this.publish();
            if (!streamedTextReceived && result.text.trim()) {
              const text = result.text.trim();
              this.addEntry({ kind: 'assistant', text });
              this.activeEventOutputs?.push({ kind: 'assistant', text });
              this.reportTurnProgress({ kind: 'assistant-delta', text });
            }
            if (tools.shouldRestart()) refreshTools = true;
            else if (tools.shouldStop()) this.addNotice('The tool call was denied; this run has stopped.', 'warn');
          } catch (error) {
            this.flushStreamedEntries();
            this.flushEventAssistantText();
            const unsupportedImageInput = this.recoverFromUnsupportedImageInput(error);
            this.runError = abortController.signal.aborted
              ? 'Run cancelled.'
              : unsupportedImageInput
                ? 'The provider rejected image input. Image input is disabled for this model, and the conversation can continue.'
                : error instanceof Error
                  ? error.message
                  : String(error);
            if (!abortController.signal.aborted) this.addNotice(this.runError, 'error');
          }
        } while (refreshTools && !abortController.signal.aborted);
        this.settleToolPreviews();

        if (current.communication?.replyTo && !finalResponseReceived && !this.runError && !abortController.signal.aborted) {
          // One tool-free finalization, based on settled results; completed actions never repeat.
          try {
            const answer = await runAgent({
              sessionId: this.session.id,
              model: this.sessionModel(),
              workspaceRoot: this.runtime.workspaceRoot,
              supportsVision: this.runtime.supportsVision,
              supportsImageToolResult: this.runtime.supportsImageToolResult,
              messages: this.conversation,
              tools: {},
              maxRetries: 0,
              abortSignal: abortController.signal,
              systemInstruction: `${this.options.systemInstruction ?? ''}\nThe owner's request requires a visible answer. Compose it from the settled work and tool results. Do not call tools or repeat actions.`,
              getProviderOptions: () => {
                const live = this.liveTurnPreferences();
                return this.runtime.getReasoningProviderOptions(live.reasoningVariantId, live.showReasoning);
              },
              onTextDelta: (delta) => {
                this.activeEventAssistantText += delta;
                this.reportTurnProgress({ kind: 'assistant-delta', text: delta });
                this.queueStreamDelta('assistant', delta);
              },
            });
            this.flushStreamedEntries();
            this.conversation = answer.conversation;
            if (this.conversationArchive.length > 0) appendUniqueQueuedMessages(this.conversationArchive, answer.response.messages);
            if (!answer.finalText.trim()) throw new Error('The run finished without a user-facing answer.');
          } catch (error) {
            this.flushStreamedEntries();
            const unsupportedImageInput = this.recoverFromUnsupportedImageInput(error);
            this.runError = abortController.signal.aborted
              ? 'Run cancelled.'
              : unsupportedImageInput
                ? 'The provider rejected image input. Image input is disabled for this model, and the conversation can continue.'
                : error instanceof Error
                  ? error.message
                  : String(error);
            if (!abortController.signal.aborted) this.addNotice(this.runError, 'error');
          }
        }

        if (titleRequest && !abortController.signal.aborted) this.generateTitleInBackground(titleRequest);
        if (abortController.signal.aborted) this.runError = 'Run cancelled.';
        if (current.eventId) {
          this.flushEventAssistantText();
          this.eventRunResults.set(current.eventId, {
            error: this.runError,
            outputs: [...(this.activeEventOutputs ?? [])],
          });
        }
        this.activeEventOutputs = null;
        this.activeEventAssistantText = '';
        this.activeTurnProgress = undefined;
        currentTurn.resolve();
        settleSteeredTurns(current.eventId);
        activeTurn = null;
        if (abortController.signal.aborted) break;
        nextTurn = this.queuedMessages.shift() ?? null;
        this.publish();
      }
    } catch (error) {
      this.flushStreamedEntries();
      this.flushEventAssistantText();
      const unsupportedImageInput = this.recoverFromUnsupportedImageInput(error);
      this.runError = abortController.signal.aborted
        ? 'Run cancelled.'
        : unsupportedImageInput
          ? 'The provider rejected image input. Image input is disabled for this model, and the conversation can continue.'
          : error instanceof Error
            ? error.message
            : String(error);
      if (!abortController.signal.aborted) this.addNotice(this.runError, 'error');
      if (activeTurn) {
        if (activeTurn.message.eventId) {
          this.eventRunResults.set(activeTurn.message.eventId, {
            error: this.runError,
            outputs: [...(this.activeEventOutputs ?? [])],
          });
        }
        activeTurn.resolve();
        settleSteeredTurns(activeTurn.message.eventId);
        activeTurn = null;
      }
    } finally {
      if (this.approvalResolver) this.approveToolCall('deny');
      if (this.questionResolver) this.answerQuestion(null);
      this.settleToolPreviews();
      this.pendingApproval = null;
      this.pendingApprovalId = null;
      this.pendingQuestion = null;
      this.questionResolver = null;
      if (abortController.signal.aborted) this.runError = 'Run cancelled.';
      this.activeEventOutputs = null;
      this.activeEventAssistantText = '';
      this.activeTurnProgress = undefined;
      this.activeEventId = undefined;
      this.busy = false;
      this.activeTurnId = undefined;
      this.activeTurnPreferences = null;
      // No run is active any more, so a late retry event must not write here.
      this.runtime.reportRetry?.(null);
      this.retryNotice = null;
      reportSessionActivity(this.session.id, false);
      if (this.activeRunAbort === abortController) this.activeRunAbort = null;
      this.publish();
      // A compaction that no step could serve runs now, before any newly
      // queued turn. The deferred re-check covers a request that read
      // `busy === true` just before this boundary cleared the flag: without it
      // the queued request would sit until the end of the next run.
      this.servePendingCompactionOrQueue();
      queueMicrotask(() => this.servePendingCompactionOrQueue());
    }
  }

  private cancelTitleGeneration(): void {
    this.titleAbort?.abort();
    this.titleAbort = null;
  }

  private generateTitleInBackground(request: { sessionId: string; message: string }): void {
    this.cancelTitleGeneration();
    const controller = new AbortController();
    this.titleAbort = controller;
    const fallback = this.session.title;
    void (async () => {
      try {
        const live = this.liveTurnPreferences();
        const providerOptions = this.runtime.getReasoningProviderOptions(live.reasoningVariantId, live.showReasoning);
        // Metadata must not rotate the active conversation's keys or report retries into its next turn.
        const model = bindSessionKeyRotation(this.runtime.model, { ...this.session.keyPositions }, () => {});
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]);
        const title = await generateSessionTitle(model, request.message, signal, providerOptions);
        if (!this.closed && !signal.aborted && this.session.id === request.sessionId && this.session.title === fallback) {
          this.session = { ...this.session, title };
          this.publish();
        }
      } catch {
        // The first-message fallback remains valid when metadata generation fails.
      } finally {
        if (this.titleAbort === controller) this.titleAbort = null;
      }
    })();
  }

  /** Run the queued compaction, otherwise start the next queued turn. */
  private servePendingCompactionOrQueue(): void {
    if (this.closed || this.busy) return;
    const pendingCompaction = this.pendingCompaction;
    if (pendingCompaction) {
      this.pendingCompaction = null;
      void this.compact(pendingCompaction.preferences, pendingCompaction.recovery, pendingCompaction.scopeRoot);
    } else if (!this.queueHold && this.queuedMessages.length > 0) {
      void this.runQueuedMessages();
    }
  }

  /**
   * Take the queued compaction request when it can run inside the live run.
   *
   * A request carrying another workspace scope cannot be served here: changing
   * the scope mid-run would move the active turn, so it stays queued for the
   * run's end, where the scope is selected before compacting.
   */
  private takePendingCompactionForStep(): { preferences: AgentTurnPreferences; recovery: boolean } | null {
    const pending = this.pendingCompaction;
    if (!pending) return null;
    if (pending.scopeRoot !== undefined && pending.scopeRoot !== this.runtime.workspaceRoot) return null;
    this.pendingCompaction = null;
    return { preferences: pending.preferences, recovery: pending.recovery };
  }

  async compact(preferences: AgentTurnPreferences, recovery = false, scopeRoot?: string): Promise<void> {
    if (this.closed) return;
    // Compaction rewrites the conversation, so it must not run while a turn is
    // in flight. Instead of refusing, queue it: the run serves it at the next
    // step boundary (after the pending tool batch, before the next model
    // request) and falls back to the run's end when no step follows.
    if (this.busy) {
      this.pendingCompaction = { preferences, recovery, ...(scopeRoot === undefined ? {} : { scopeRoot }) };
      this.addNotice('Compaction is queued; it runs at the next step boundary or when the run finishes.');
      return;
    }
    if (scopeRoot !== undefined && this.runtime.selectWorkspaceRoot) await this.runtime.selectWorkspaceRoot(scopeRoot);
    if (this.conversation.length === 0) {
      this.addNotice('There is no conversation to compact.');
      return;
    }
    const abortController = new AbortController();
    this.activeRunAbort = abortController;
    this.busy = true;
    reportSessionActivity(this.session.id, true);
    this.publish();
    try {
      const [{ getAgentContext }, { compactConversation }] = await Promise.all([import('./agent.js'), import('./compaction.js')]);
      const context = getAgentContext(
        this.conversation,
        this.runtime.supportsImageToolResult,
        this.runtime.workspaceRoot,
        this.options.systemInstruction,
        this.runtime.supportsVision,
        undefined,
        this.session.id,
      );
      const schemaSanitizer = this.toolSchemaSanitizer();
      const tools = await this.runtime.registry.createModelTools({
        approve: async () => false,
        onResult: () => {},
        ...(schemaSanitizer ? { schemaSanitizer } : {}),
      });
      const result = await compactConversation({
        ...context,
        archivePath: sessionFilePath(this.session.id),
        tools: tools.tools,
        model: this.sessionModel(),
        contextWindowTokens: this.runtime.contextWindowTokens,
        outputLimitTokens: this.runtime.outputLimitTokens,
        ...(this.lastContextUsage !== undefined ? { previousContextTokens: this.lastContextUsage } : {}),
        ...(this.lastContextEstimate !== undefined ? { previousContextEstimateTokens: this.lastContextEstimate } : {}),
        ...(this.contextGrowthThisTurn !== undefined ? { recentContextGrowthTokens: this.contextGrowthThisTurn } : {}),
        providerOptions: this.runtime.getReasoningProviderOptions(preferences.reasoningVariantId, preferences.showReasoning),
        onStart: () => {
          this.flushStreamedEntries();
          // The row exists from the first moment so the reader sees "compacting"
          // instead of a silent pause; applyCompaction replaces it in place.
          const entry: Extract<SessionEntry, { kind: 'compaction' }> = {
            kind: 'compaction',
            status: 'running',
            ...(this.lastContextUsage === undefined ? {} : { beforeTokens: this.lastContextUsage }),
          };
          this.compactionEntry = entry;
          this.addEntry(entry);
          if (recovery)
            this.addNotice(
              'Recovering compaction: earlier reasoning is omitted from this one request; dialogue and tool data are preserved. The full transcript remains archived.',
            );
        },
        onTextDelta: (delta) => this.queueStreamDelta('assistant', delta, 'compaction'),
        onReasoningDelta: (delta) => this.queueStreamDelta('reasoning', delta, 'compaction'),
        abortSignal: abortController.signal,
        force: true,
        ...(recovery ? { recovery: true } : {}),
      });
      if (result) this.applyCompaction(result);
    } catch (error) {
      this.flushStreamedEntries();
      // A compaction that stopped halfway is a fact about the context, not a
      // silent failure: the row says so and keeps its start size.
      const started = this.compactionEntry;
      this.compactionEntry = null;
      if (started) {
        this.replaceEntry(started, {
          kind: 'compaction',
          status: 'failed',
          ...(started.beforeTokens === undefined ? {} : { beforeTokens: started.beforeTokens }),
        });
      }
      const unsupportedImageInput = this.recoverFromUnsupportedImageInput(error);
      if (!abortController.signal.aborted)
        this.addNotice(
          unsupportedImageInput
            ? 'The provider rejected image input. Image input is disabled for this model, and the conversation can continue.'
            : `Compaction failed: ${error instanceof Error ? error.message : String(error)}`,
          unsupportedImageInput ? 'warn' : 'error',
        );
    } finally {
      this.busy = false;
      this.activeTurnId = undefined;
      this.runtime.reportRetry?.(null);
      this.retryNotice = null;
      reportSessionActivity(this.session.id, false);
      if (this.activeRunAbort === abortController) this.activeRunAbort = null;
      this.publish();
      if (!this.closed && !this.queueHold && this.queuedMessages.length > 0) void this.runQueuedMessages();
    }
  }

  private applyCompaction(result: CompactionResult): void {
    this.flushStreamedEntries();
    if (this.conversationArchive.length === 0) this.conversationArchive = [...this.conversation];
    this.conversation = result.messages;
    // A compaction rewrites the conversation, so the cached prefix is already
    // gone; the next turn rebuilds the system prompt from fresh context.
    this.frozenSystem = null;
    this.lastContextUsage = undefined;
    this.lastContextEstimate = undefined;
    this.contextUsageBaseline = undefined;
    this.contextGrowthThisTurn = undefined;
    const session = { ...this.session };
    delete session.contextTokens;
    delete session.contextEstimateTokens;
    delete session.contextGrowthTokens;
    this.session = session;
    // The compaction row replaces the one that was running, so the transcript
    // shows one event that changed state instead of two unrelated notices.
    const finished: Extract<SessionEntry, { kind: 'compaction' }> = {
      kind: 'compaction',
      status: 'done',
      beforeTokens: result.beforeTokens,
      afterTokens: result.afterTokens,
    };
    const started = this.compactionEntry;
    this.compactionEntry = null;
    if (started) this.replaceEntry(started, finished);
    else this.addEntry(finished);
  }

  /**
   * One accounting row per model request. Nothing here can fail a run: the sink is
   * best effort and the ledger write is fire and forget.
   */
  private onStepUsage(report: StepUsageReport): void {
    const sink = this.runtime.recordUsage;
    if (!sink) return;
    sink(
      {
        sessionId: this.session.id,
        ...(this.activeEventId ? { eventId: this.activeEventId } : {}),
        runKind: 'chat',
        ...(this.runtime.workspaceRoot ? { workspaceRoot: this.runtime.workspaceRoot } : {}),
        providerId: this.runtime.providerId,
        modelId: this.runtime.modelId,
        atMs: report.startedAt,
        endedMs: report.endedAt,
        attempt: report.attempt,
        status: report.status,
        tokens: report.usage,
        ...(report.raw === undefined ? {} : { usageRaw: report.raw }),
        ...(report.providerMetadata === undefined ? {} : { providerMetadata: report.providerMetadata }),
        ...(report.responseId === undefined ? {} : { responseId: report.responseId }),
      },
      `${this.session.id}:${report.startedAt}:${report.attempt}`,
    );
  }

  private onContextUsage(inputTokens: number | null, contextEstimateTokens: number): void {
    if (inputTokens !== null) {
      this.lastContextUsage = inputTokens;
      this.lastContextEstimate = contextEstimateTokens;
      if (this.contextUsageBaseline === undefined) this.contextUsageBaseline = inputTokens;
      else {
        const growth = Math.max(0, inputTokens - this.contextUsageBaseline);
        this.contextGrowthThisTurn = Math.max(this.contextGrowthThisTurn ?? 0, growth);
      }
    }
    this.session = {
      ...this.session,
      ...(this.runtime.contextWindowTokens === null ? {} : { contextWindowTokens: this.runtime.contextWindowTokens }),
      ...(inputTokens === null ? {} : { contextTokens: inputTokens }),
      ...(inputTokens === null ? {} : { contextEstimateTokens }),
      ...(this.contextGrowthThisTurn === undefined ? {} : { contextGrowthTokens: this.contextGrowthThisTurn }),
    };
    this.publish();
  }
}

function toolIdentity(request: Pick<ToolCallRequest, 'providerId' | 'name'>): string {
  return `${request.providerId}:${request.name}`;
}

/** Worker session id for subagent-family results; the machine-readable half of the display contract. */
function workerSessionId(request: Pick<ToolCallRequest, 'providerId' | 'name'>, value: unknown): string | undefined {
  if (
    request.providerId !== 'host' ||
    (request.name !== 'subagent' && request.name !== 'inbox' && request.name !== 'subagent_poll' && request.name !== 'subagent_stop')
  ) {
    return undefined;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  if (request.name === 'inbox') {
    const items = (value as Record<string, unknown>).items;
    if (!Array.isArray(items) || items.length !== 1) return undefined;
    const item = items[0];
    if (!item || typeof item !== 'object' || item.source !== 'Subagent') return undefined;
    const session = item.content?.session;
    return typeof session === 'string' ? session : undefined;
  }
  const session = (value as Record<string, unknown>).session;
  return typeof session === 'string' && session ? session : undefined;
}

export function toolDisplayCommand(request: Pick<ToolCallRequest, 'providerId' | 'name' | 'input'>): string {
  return displayToolCommand({ ...request, input: redactSensitive(request.input) as Record<string, unknown> });
}

/** Complete input, redacted once before it enters the transcript. */
export function toolDisplayInput(input: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(
    JSON.stringify(input, (key, value: unknown) => {
      const kind = classifySensitiveEntry(key, value);
      if (kind === 'secret') return '[redacted]';
      if (kind === 'media') return `[media payload omitted; ${(value as string).length} chars]`;
      return typeof value === 'string' ? redactSensitiveText(value) : value;
    }),
  ) as Record<string, unknown>;
}

function toolDisplayName(providerId: string, name: string): string {
  return providerId === 'host' ? name : `${providerId}/${name}`;
}

/** Best available one-line label from the fields a provider has streamed so far. */
export function toolPreviewCommand(
  providerId: string,
  name: string,
  fields: readonly { key: string; value: string }[],
  title?: string,
): string {
  const input: Record<string, unknown> = {};
  for (const field of fields) input[field.key] = field.value;
  if (providerId === 'host' && name === 'execute_command' && typeof input.command === 'string') return input.command;
  if (providerId === 'host' && (name === 'file_read' || name === 'file_write' || name === 'file_edit') && typeof input.path === 'string')
    return `${name === 'file_read' ? 'Read' : name === 'file_write' ? 'Write' : 'Edit'} ${input.path}`;
  if (providerId === 'host' && (name === 'glob' || name === 'grep') && typeof input.pattern === 'string') {
    const source = typeof input.path === 'string' ? ` in ${input.path}` : '';
    return `${name === 'glob' ? 'Glob' : 'Grep'} ${input.pattern}${source}`;
  }
  if (providerId === 'host' && name === 'mcp_manage' && typeof input.action === 'string') {
    return ['mcp_manage', input.action, input.serverId].filter((part) => typeof part === 'string').join(' ');
  }
  if (providerId === 'host') {
    const pick = (key: string, maxChars = 60): string | undefined => {
      const field = fields.find((candidate) => candidate.key === key);
      if (!field || !field.value) return undefined;
      return field.value.length > maxChars ? `${field.value.slice(0, maxChars)}…` : field.value;
    };
    switch (name) {
      case 'inbox':
        return `Inbox ${pick('action') ?? 'list'}${pick('source') ? ` · ${pick('source')}` : ''}`;
      case 'question': {
        const question = pick('question', 80);
        return question ? `Ask "${question}"` : 'question';
      }
      case 'subagent': {
        const mode = pick('mode', 8);
        const task = pick('task', 120);
        return `subagent${mode ? ` ${mode}` : ''}${task ? ` · ${task}` : ''}`;
      }
      case 'subagent_poll': {
        const session = pick('session', 8);
        return session ? `Poll ${session}` : 'subagent_poll';
      }
      case 'subagent_stop': {
        const session = pick('session', 8);
        return session ? `Stop ${session}` : 'subagent_stop';
      }
      case 'session_read': {
        const session = pick('session', 8);
        return session ? `Read session ${session}` : 'session_read';
      }
      case 'session_search': {
        const query = pick('query', 60);
        return query ? `Search sessions "${query}"` : 'session_search';
      }
      case 'session_list': {
        const scope = pick('scope', 9);
        return scope ? `Sessions ${scope}` : 'session_list';
      }
      case 'session_message': {
        const session = pick('session', 8);
        return session ? `Message ${session}` : 'session_message';
      }
      case 'parent_message': {
        const text = pick('text', 80);
        return text ? `Note "${text}"` : 'parent_message';
      }
      case 'memory_search': {
        const query = pick('query', 60);
        return query ? `Search memory "${query}"` : 'memory_search';
      }
      case 'schedule': {
        const action = pick('action', 12);
        return action ? `Schedule ${action}` : 'schedule';
      }
    }
  }
  const first = fields[0];
  return first ? `${toolDisplayName(providerId, name)} ${first.value}` : toolDisplayName(providerId, name);
}

export function formatToolResult(request: Pick<ToolCallRequest, 'providerId' | 'name'>, value: unknown): { outcome: string; text: string } {
  if (value === null || value === undefined) return { outcome: 'result', text: '' };
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { outcome: 'result', text: typeof value === 'string' ? value : String(value) };
  }
  const result = value as Record<string, unknown>;
  if (request.providerId === 'host') {
    const display = displayHostToolResult(request.name, result);
    if (display !== undefined) return display;
  }
  if (typeof result.error === 'string' && result.error) {
    return { outcome: typeof result.status === 'string' ? result.status : 'error', text: result.error };
  }
  if (typeof result.message === 'string' && result.message) {
    return { outcome: typeof result.status === 'string' ? result.status : 'result', text: result.message };
  }
  return formatExecOutput(result);
  if (title !== undefined) return title;
}

/** Content-first display text for host tool results; undefined defers to the generic rules. */
function displayHostToolResult(name: string, result: Record<string, unknown>): { outcome: string; text: string } | undefined {
  if (name === 'inbox' && Array.isArray(result.items)) {
    const lines = [`Inbox · ${result.items.length} notification(s)`];
    for (const raw of result.items) {
      if (!raw || typeof raw !== 'object') continue;
      const item = raw as Record<string, unknown>;
      const content = item.content;
      const worker =
        content && typeof content === 'object' && !Array.isArray(content)
          ? displayHostToolResult('subagent_poll', content as Record<string, unknown>)
          : undefined;
      lines.push(
        `${String(item.source)}${worker ? `\n${worker.text}` : content === undefined ? ` · ${String(item.state)}` : `\n${JSON.stringify(content)}`}`,
      );
    }
    if (Array.isArray(result.errors)) for (const error of result.errors) lines.push(`! ${JSON.stringify(error)}`);
    return { outcome: String(result.status ?? 'completed'), text: lines.join('\n') };
  }
  switch (name) {
    case 'file_write': {
      if (result.status !== 'completed') return undefined;
      const stat = diffStatLine(result);
      return { outcome: 'completed', text: stat ? stat : 'Wrote' };
    }
    case 'file_edit': {
      if (result.status !== 'completed') return undefined;
      const stat = diffStatLine(result);
      return { outcome: 'completed', text: stat ? stat : 'Edited' };
    }
    case 'file_read': {
      if (result.status !== 'completed') return undefined;
      if (typeof result.content === 'string') {
        const path = typeof result.path === 'string' ? result.path : 'file';
        const offset = typeof result.offset === 'number' ? result.offset : 1;
        const endLine = typeof result.endLine === 'number' ? result.endLine : offset;
        const more = result.truncated === true || result.hasMore === true ? '+' : '';
        return { outcome: 'completed', text: `${path} · lines ${offset}–${endLine}${more}\n${result.content}` };
      }
      if (Array.isArray(result.entries)) {
        const path = typeof result.path === 'string' ? result.path : 'directory';
        const total = typeof result.totalEntries === 'number' ? result.totalEntries : result.entries.length;
        const names = result.entries
          .map((entry) => {
            if (typeof entry !== 'object' || entry === null) return null;
            const item = entry as Record<string, unknown>;
            if (typeof item.name !== 'string') return null;
            return `${item.name}${item.type === 'directory' ? '/' : ''}`;
          })
          .filter((name): name is string => name !== null);
        return { outcome: 'completed', text: `${path} · ${total} ${total === 1 ? 'entry' : 'entries'}\n${names.join('\n')}` };
      }
      return undefined;
    }
    case 'execute_command': {
      const base = formatExecOutput(result);
      if (typeof result.exitCode === 'number' && result.exitCode !== 0) {
        return { outcome: base.outcome, text: `exit ${result.exitCode}${base.text ? `\n${base.text}` : ''}` };
      }
      if (result.truncated === true && base.text) return { outcome: base.outcome, text: `${base.text}\n… (output truncated)` };
      return base;
    }
    case 'glob': {
      if (result.status !== 'completed') return undefined;
      const files = Array.isArray(result.files) ? result.files.filter((file): file is string => typeof file === 'string') : [];
      const count = typeof result.count === 'number' ? result.count : files.length;
      return {
        outcome: 'completed',
        text: `${count} file${count === 1 ? '' : 's'}${result.truncated === true ? '+' : ''}\n${files.join('\n')}`,
      };
    }
    case 'grep': {
      if (result.status !== 'completed') return undefined;
      const matches = Array.isArray(result.matches) ? result.matches : [];
      const lines = matches
        .map((match) => {
          if (typeof match !== 'object' || match === null) return null;
          const item = match as Record<string, unknown>;
          if (typeof item.path !== 'string' || typeof item.line !== 'number' || typeof item.text !== 'string') return null;
          return `${item.path}:${item.line}: ${oneLine(item.text, 200) ?? ''}`;
        })
        .filter((line): line is string => line !== null);
      return {
        outcome: 'completed',
        text: `${matches.length} match${matches.length === 1 ? '' : 'es'}${result.truncated === true ? '+' : ''}\n${lines.join('\n')}`,
      };
    }
    case 'session_list': {
      if (result.status !== 'completed' || !Array.isArray(result.sessions)) return undefined;
      const scope = result.scope === 'workspace' ? 'workspace' : 'all';
      const lines = result.sessions
        .map((session) => {
          if (typeof session !== 'object' || session === null) return null;
          const item = session as Record<string, unknown>;
          if (typeof item.id !== 'string' || typeof item.title !== 'string') return null;
          const date = typeof item.updatedAt === 'string' ? ` · ${item.updatedAt.slice(0, 16).replace('T', ' ')}` : '';
          return `- ${item.title} (${item.id.slice(0, 8)}${date})`;
        })
        .filter((line): line is string => line !== null);
      return {
        outcome: 'completed',
        text: `${result.sessions.length} session${result.sessions.length === 1 ? '' : 's'} (${scope})\n${lines.join('\n')}`,
      };
    }
    case 'session_search': {
      if (result.status !== 'completed' || !Array.isArray(result.matches)) return undefined;
      const total = typeof result.total === 'number' ? result.total : result.matches.length;
      const query = typeof result.query === 'string' ? result.query : '';
      const lines = result.matches
        .map((match) => {
          if (typeof match !== 'object' || match === null) return null;
          const item = match as Record<string, unknown>;
          if (typeof item.sessionId !== 'string' || typeof item.title !== 'string') return null;
          const entry = typeof item.entry === 'number' ? ` #${item.entry}` : '';
          const snippet = typeof item.snippet === 'string' ? oneLine(item.snippet, 160) : undefined;
          return `- ${item.title}${entry}${snippet ? `: ${snippet}` : ''}`;
        })
        .filter((line): line is string => line !== null);
      return { outcome: 'completed', text: `${total} match${total === 1 ? '' : 'es'} for "${query}"\n${lines.join('\n')}` };
    }
    case 'session_read': {
      if (result.status !== 'completed' || !Array.isArray(result.entries)) return undefined;
      const session = typeof result.session === 'object' && result.session !== null ? (result.session as Record<string, unknown>) : null;
      const title = session !== null && typeof session.title === 'string' ? session.title : 'session';
      const id = session !== null && typeof session.id === 'string' && session.id ? ` (${session.id.slice(0, 8)})` : '';
      const entryCount = typeof result.entryCount === 'number' ? result.entryCount : result.entries.length;
      const offset = typeof result.offset === 'number' ? result.offset : 1;
      const endOffset = typeof result.endOffset === 'number' ? result.endOffset : offset;
      const lines = [`Session ${title}${id} · ${offset}–${endOffset} of ${entryCount}`];
      let used = lines[0]!.length;
      for (const entry of result.entries) {
        if (typeof entry !== 'object' || entry === null) continue;
        const item = entry as Record<string, unknown>;
        let line: string | undefined;
        if (item.kind === 'tool') {
          const command = oneLine(item.command, 100) ?? '?';
          const firstResult = typeof item.result === 'string' ? oneLine(item.result.split('\n')[0], 100) : undefined;
          line = `› ${command}${firstResult ? ` → ${firstResult}` : ''}`;
        } else if (typeof item.text === 'string') {
          line = oneLine(item.text, 200);
        }
        if (line === undefined) continue;
        if (used + line.length > 3000) {
          lines.push('…');
          break;
        }
        used += line.length;
        lines.push(line);
      }
      return { outcome: 'completed', text: lines.join('\n') };
    }
    case 'memory_search': {
      if (result.status !== 'completed' || !Array.isArray(result.matches)) return undefined;
      const query = typeof result.query === 'string' ? result.query : '';
      const lines = result.matches
        .map((match) => {
          if (typeof match !== 'object' || match === null) return null;
          const item = match as Record<string, unknown>;
          if (typeof item.title !== 'string' || typeof item.path !== 'string') return null;
          const snippet = typeof item.snippet === 'string' ? oneLine(item.snippet, 160) : undefined;
          return `- ${item.title} (${item.path})${snippet ? `: ${snippet}` : ''}`;
        })
        .filter((line): line is string => line !== null);
      return {
        outcome: 'completed',
        text: `${result.matches.length} note${result.matches.length === 1 ? '' : 's'} for "${query}"\n${lines.join('\n')}`,
      };
    }
    case 'question': {
      if (result.status === 'answered' && typeof result.answer === 'string') return { outcome: 'answered', text: result.answer };
      return undefined;
    }
    case 'subagent': {
      if (result.status === 'completed' && typeof result.report === 'string') return { outcome: 'completed', text: result.report };
      if (result.status === 'started' && typeof result.session === 'string') {
        const mode = typeof result.mode === 'string' ? result.mode : 'worker';
        return { outcome: 'started', text: `Started ${mode} worker (${result.session.slice(0, 8)})` };
      }
      return undefined;
    }
    case 'subagent_poll': {
      if (result.status !== 'running' && result.status !== 'finished') return undefined;
      const session = typeof result.session === 'string' && result.session ? ` (${result.session.slice(0, 8)})` : '';
      const lines: string[] = [];
      if (result.status === 'running') {
        const elapsed = typeof result.elapsedSec === 'number' ? ` · ${result.elapsedSec}s` : '';
        const calls = typeof result.toolCalls === 'number' ? ` · ${result.toolCalls} call${result.toolCalls === 1 ? '' : 's'}` : '';
        const lastTool = typeof result.lastTool === 'string' && result.lastTool ? result.lastTool.split(':').pop() : undefined;
        const last = lastTool ? ` · ${lastTool}` : '';
        lines.push(`Running${session}${elapsed}${calls}${last}`);
      } else {
        lines.push(`Finished${session}`);
        if (typeof result.report === 'string' && result.report) lines.push(result.report);
      }
      if (Array.isArray(result.notes)) {
        for (const note of result.notes) {
          if (typeof note !== 'string' || !note) continue;
          const line = oneLine(note, 160);
          if (line) lines.push(`- ${line}`);
        }
      }
      if (typeof result.error === 'string' && result.error) lines.push(`! ${result.error}`);
      return { outcome: typeof result.status === 'string' ? result.status : 'result', text: lines.join('\n') };
    }
    case 'subagent_stop': {
      if (result.status !== 'stopped' || typeof result.session !== 'string') return undefined;
      return { outcome: 'stopped', text: `Stopped worker (${result.session.slice(0, 8)})` };
    }
    default:
      return undefined;
  }
}

/** `(+A -R)` over a result's diff stats, a line-count fallback, or empty when unknown. */
function diffStatLine(result: Record<string, unknown>): string {
  const added = typeof result.addedLines === 'number' ? result.addedLines : null;
  const removed = typeof result.removedLines === 'number' ? result.removedLines : null;
  if (added !== null && removed !== null) return `(+${added} -${removed})`;
  if (typeof result.lineCount === 'number') {
    return typeof result.oldLineCount === 'number' && result.oldLineCount !== result.lineCount
      ? `(${result.oldLineCount} → ${result.lineCount} lines)`
      : `(${result.lineCount} lines)`;
  }
  return '';
}

/** A whitespace-collapsed one-liner over already-redacted display text; undefined when absent. */
function oneLine(value: unknown, maxChars: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const single = value.replace(/\s+/g, ' ').trim();
  if (!single) return undefined;
  return single.length > maxChars ? `${single.slice(0, maxChars)}…` : single;
}

function formatExecOutput(result: Record<string, unknown>): { outcome: string; text: string } {
  if ('stdout' in result || 'stderr' in result) {
    const status = typeof result.status === 'string' ? result.status : 'completed';
    const exitCode = typeof result.exitCode === 'number' ? ` · exit ${result.exitCode}` : '';
    const text = [result.stdout, result.stderr, result.error]
      .filter((part): part is string => typeof part === 'string' && part.length > 0)
      .join('\n')
      .trim();
    return { outcome: `${status}${exitCode}`, text };
  }
  if (Array.isArray(result.content)) {
    const text = result.content
      .map((part: unknown) => {
        if (part && typeof part === 'object' && 'text' in part && typeof part.text === 'string') return part.text;
        if (part && typeof part === 'object' && 'type' in part && typeof part.type === 'string') return `[${part.type}]`;
        return '';
      })
      .filter(Boolean)
      .join('\n');
    const structured = result.structuredContent;
    return {
      outcome: result.isError === true ? 'server error' : 'result',
      text: text || (structured === undefined ? '' : (JSON.stringify(structured, null, 2) ?? String(structured))),
    };
  }
  return { outcome: typeof result.status === 'string' ? result.status : 'result', text: JSON.stringify(result, null, 2) ?? String(result) };
}

function messageImageCount(message: QueuedMessage): number {
  return message.images.length + (message.attachments?.filter((attachment) => attachment.mediaType.startsWith('image/')).length ?? 0);
}

function queuedUserMessageToModelMessage(message: QueuedMessage): ModelMessage {
  const content: Array<{ type: 'text'; text: string }> = [];
  const source = message.communication?.source;
  const sourceLabel =
    source === 'telegram'
      ? '[Host context: owner message via Telegram]'
      : source === 'terminal'
        ? '[Host context: owner message via terminal]'
        : source === 'inbox' || source === 'owner-inbox' || source === 'team' || source === 'worker'
          ? '[Host context: inbox notification]'
          : '';
  const workspaceLabel = message.workspaceRoot ? `[Host context: active workspace ${message.workspaceRoot.replace(/[\r\n]/g, ' ')}]` : '';
  const projectLabel = message.projectContext
    ? `[Host context: selected project ${JSON.stringify(message.projectContext)}; commands use the first source folder]`
    : '';
  // A Telegram turn has to be answered in Telegram: text kept in this session is
  // invisible to the owner, which is an easy and completely silent mistake.
  const deliveryHint =
    source === 'telegram'
      ? '[Host context: reply through send_message_to_owner; text written only in this session never reaches the owner]'
      : '';
  if (message.text || sourceLabel || workspaceLabel)
    content.push({
      type: 'text',
      text: [sourceLabel, workspaceLabel, projectLabel, deliveryHint, message.text].filter(Boolean).join('\n'),
    });
  if (message.attachments?.length) content.push({ type: 'text', text: attachmentReferences(message.attachments) });
  return { role: 'user', content, ...(message.eventId ? { providerOptions: { ranite: { queuedMessageId: message.eventId } } } : {}) };
}

function appendUniqueQueuedMessages(target: ModelMessage[], messages: ModelMessage[]): void {
  const existing = new Set(
    target.flatMap((message) =>
      message.role === 'user' && typeof message.providerOptions?.ranite?.queuedMessageId === 'string'
        ? [message.providerOptions.ranite.queuedMessageId]
        : [],
    ),
  );
  for (const message of messages) {
    if (message.role === 'user' && typeof message.providerOptions?.ranite?.queuedMessageId === 'string') {
      const id = message.providerOptions.ranite.queuedMessageId;
      if (existing.has(id)) continue;
      existing.add(id);
    }
    target.push(message);
  }
}

async function generateSessionTitle(
  model: LanguageModel,
  firstMessage: string,
  abortSignal?: AbortSignal,
  providerOptions?: ReasoningVariant['providerOptions'],
): Promise<string> {
  const { generateText, jsonSchema, Output } = await import('ai');
  const result = await generateText({
    model,
    maxRetries: 0,
    output: Output.object({
      name: 'chat_title',
      description:
        'A concise, specific 2–4 word chat title in the same language as the user’s first message. Do not include a label or explanation.',
      schema: jsonSchema<{ title: string }>({
        type: 'object',
        properties: {
          title: { type: 'string', description: 'The title itself, 2–4 words, with no prefix, label, colon, or explanation.' },
        },
        required: ['title'],
        additionalProperties: false,
      }),
    }),
    ...(abortSignal ? { abortSignal } : {}),
    ...(providerOptions && Object.keys(providerOptions).length > 0 ? { providerOptions } : {}),
    system:
      'Read the user’s first message and create a concise, specific title for this chat. Use 2–4 words in the same language as the message. Put the title in the title field; do not make it a sentence.',
    prompt: truncateUtf8Bytes(firstMessage, 4 * 1024),
  });
  return result.output.title.trim() || fallbackSessionTitle(firstMessage);
}

function fallbackSessionTitle(message: string): string {
  const words = message.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean).slice(0, 4);
  if (words.length === 0) return 'New session';
  if (words.length === 1) return `${words[0]} chat`;
  return words.join(' ').slice(0, 64);
}

/**
 * A short, factual cause for a retry line: the status code when the provider
 * sent one, otherwise that the request failed. No advice, no speculation.
 */
function describeRetryCause(error: unknown): string {
  const status = error !== null && typeof error === 'object' ? (error as { statusCode?: unknown }).statusCode : undefined;
  if (typeof status === 'number') {
    if (status === 429) return 'Rate limited (429)';
    if (status === 408) return 'Request timed out (408)';
    if (status === 409) return 'Conflict (409)';
    if (status >= 500) return `Provider error (${status})`;
    return `Request failed (${status})`;
  }
  return 'Request failed';
}

function truncateUtf8Bytes(value: string, maxBytes: number): string {
  let bytes = 0;
  let end = 0;
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, 'utf8');
    if (bytes + characterBytes > maxBytes) break;
    bytes += characterBytes;
    end += character.length;
  }
  return value.slice(0, end);
}
