import type { JSONValue, LanguageModel, ModelMessage } from 'ai';
import type { CompactionResult } from './compaction.js';
import type { ToolActionUpdate } from './activity-ledger.js';
import {
  createSession,
  listSavedSessions,
  loadSavedSession,
  saveSession,
  sessionTitle,
  type SavedSession,
  type SessionEntry,
  type SessionSummary,
  type NoticeTone,
} from './session-store.js';
import { isToolRequestWhitelisted, rememberToolRequest } from './tool-permissions.js';
import { ensureHostOwnedRoots } from './host-owned-paths.js';
import { consumeApproval, recordDeniedAction } from './review-overrides.js';
import type { ReasoningSupport, ReasoningVariant } from './provider/registry.js';
import { loadSettings, type ApprovalMode } from './settings.js';
import { autoReviewFingerprint, reviewToolRequest, type AutoReviewOptions, type AutoReviewResult } from './auto-review.js';
import type { ToolApprovalOutcome, ToolCallRequest, ToolRegistry, ToolUserQuestion } from './tools/registry.js';
import { ToolInputPreview } from './tool-preview.js';
import { redactSensitive, redactSensitiveText } from './sensitive-data.js';
import { DEFAULT_SESSION_LIST_LIMIT } from './tools/session-list.js';
import { reportSessionActivity } from './session-registry.js';
import { getDataPath } from './paths.js';
import { sameReplyRoute, type TurnCommunication } from './communication.js';
import { isUnsupportedImageInputError, omitUnsupportedImageInputs } from './image.js';

export type AgentProviderOptions = Record<string, Record<string, JSONValue>>;
export type ApprovalDecision = 'allow' | 'deny' | 'always';
export type AgentTurnProgress =
  | { kind: 'start' }
  | { kind: 'assistant-delta'; text: string }
  | { kind: 'tool-start'; tool: string }
  | { kind: 'tool-result'; tool: string; outcome: string };
export type AgentEventOutput = { kind: 'assistant'; text: string };
export type QueuedMessage = {
  text: string;
  images: Array<{ base64: string; mediaType: 'image/png' }>;
  eventId?: string;
  /** Authenticated host facts, never accepted from client message payloads. */
  communication?: TurnCommunication;
  /** Host-only progress sink for transports that display a live turn. */
  onProgress?: (progress: AgentTurnProgress) => void;
  /** Host-bound filesystem and memory scope for this queued turn; never trusted from IPC input. */
  workspaceRoot?: string;
  /** Host-only trust labels for explicitly configured observer tasks; never accepted over TUI IPC. */
  reviewAuthorization?: { kind: 'background-task'; name: string; instruction: string; triggerFacts: unknown };
};

export interface AgentSessionRuntimeView {
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
  selectModel: (providerId: string, modelId: string) => Promise<void>;
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
  queuedMessages: { text: string; imageCount: number }[];
  sessionSaveError: string | null;
  streamingAssistantEntry: SessionEntry | null;
}

export interface AgentTurnPreferences {
  reasoningVariantId: string;
  showReasoning: boolean;
}

type QueuedTurn = {
  message: QueuedMessage;
  preferences: AgentTurnPreferences;
  resolve: () => void;
  reject: (error: unknown) => void;
};

export type AgentEventRunResult = { error: string | null; outputs: AgentEventOutput[]; replyHandledByEventId?: string };

export interface AgentSessionOptions {
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
  subscribe: (listener: () => void) => () => void;
  readonly isBusy: boolean;
  addEntry(entry: SessionEntry): void;
  approveToolCall(decision: ApprovalDecision, requestId?: string): void;
  answerQuestion(answer: string | null, questionId?: string): void;
  stop(options?: { keepQueue?: boolean; holdQueue?: boolean }): void;
  sendMessage(message: QueuedMessage, preferences: AgentTurnPreferences): Promise<void>;
  compact(preferences: AgentTurnPreferences, recovery?: boolean): Promise<void>;
  selectModel(providerId: string, modelId: string): Promise<void>;
  listSessions(): SessionSummary[] | Promise<SessionSummary[]>;
  loadSession(id: string): SavedSession | AgentSessionView | null | Promise<SavedSession | AgentSessionView | null>;
  createNewSession(): void | Promise<void>;
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
  private readonly listeners = new Set<() => void>();
  private readonly queuedMessages: QueuedTurn[] = [];
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
  private readonly pendingStreamDeltas: Array<{ kind: 'assistant' | 'reasoning'; text: string }> = [];
  private busy = false;
  private closed = false;
  /** A compaction requested while a run was in flight; runs at the run's end. */
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
  get isBusy(): boolean {
    return this.busy;
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
    const queuedMessages = this.queuedMessages.map((turn) => ({ text: turn.message.text, imageCount: turn.message.images.length }));
    const first = queuedMessages[0] ?? null;
    const { conversation, conversationArchive, ...session } = this.session;
    void conversation;
    void conversationArchive;
    return {
      session,
      busy: this.busy,
      pendingApproval: this.pendingApproval,
      pendingApprovalId: this.pendingApprovalId,
      pendingQuestion: this.pendingQuestion,
      queuedMessageCount: this.queuedMessages.length,
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

  private persistLatest(): void {
    const latest = this.latestSessionSnapshot;
    if (!latest || !latest.entries.some((entry) => entry.kind === 'user')) return;
    try {
      this.session = saveSession(latest);
      this.sessionSaveError = null;
    } catch (error) {
      this.sessionSaveError = error instanceof Error ? error.message : String(error);
    }
    this.publish(false);
  }

  flushSave(): void {
    if (this.sessionSaveTimer !== null) clearTimeout(this.sessionSaveTimer);
    this.sessionSaveTimer = null;
    this.latestSessionSnapshot = this.persistableSession();
    this.persistLatest();
  }

  addEntry(entry: SessionEntry): void {
    this.session = { ...this.session, entries: [...this.session.entries, entry] };
    this.publish();
  }

  private replaceEntry(previous: SessionEntry, next: SessionEntry): void {
    const index = this.session.entries.indexOf(previous);
    if (index < 0) return;
    const entries = [...this.session.entries];
    entries[index] = next;
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
      ...(session.workspaceRoot === undefined && typeof this.sessionWorkspaceScope === 'string'
        ? { workspaceRoot: this.sessionWorkspaceScope }
        : {}),
    };
    this.conversation = [...session.conversation];
    this.conversationArchive = [...(session.conversationArchive ?? [])];
    this.lastContextUsage = session.contextTokens;
    this.lastContextEstimate = session.contextEstimateTokens;
    this.contextUsageBaseline = session.contextTokens;
    this.contextGrowthThisTurn = session.contextGrowthTokens;
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

  createNewSession(): void {
    if (this.busy) return;
    this.flushSave();
    this.session = createSession(
      this.runtime.providerId,
      this.runtime.modelId,
      this.runtime.contextWindowTokens ?? undefined,
      this.sessionWorkspaceScope ?? undefined,
    );
    this.conversation = [];
    this.conversationArchive = [];
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
  stop(options: { keepQueue?: boolean; holdQueue?: boolean } = {}): void {
    if (options.holdQueue === true) {
      this.queueHold = true;
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
    this.stop();
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

  private appendStreamedText(delta: string): void {
    const previous = this.streamedAssistantEntry;
    if (previous?.kind === 'assistant') {
      const next: SessionEntry = { kind: 'assistant', text: previous.text + delta };
      this.streamedAssistantEntry = next;
      this.replaceEntry(previous, next);
    } else {
      const entry: SessionEntry = { kind: 'assistant', text: delta };
      this.streamedAssistantEntry = entry;
      this.addEntry(entry);
    }
  }

  private appendStreamedReasoning(delta: string): void {
    if (!delta) return;
    const previous = this.streamedReasoningEntry;
    if (previous?.kind === 'reasoning') {
      const next: SessionEntry = { kind: 'reasoning', text: previous.text + delta };
      this.streamedReasoningEntry = next;
      this.replaceEntry(previous, next);
    } else {
      const entry: SessionEntry = { kind: 'reasoning', text: delta };
      this.streamedReasoningEntry = entry;
      const assistantIndex = this.streamedAssistantEntry ? this.session.entries.indexOf(this.streamedAssistantEntry) : -1;
      const entries = [...this.session.entries];
      entries.splice(assistantIndex < 0 ? entries.length : assistantIndex, 0, entry);
      this.session = { ...this.session, entries };
      this.publish();
    }
  }

  private queueStreamDelta(kind: 'assistant' | 'reasoning', text: string): void {
    if (!text) return;
    const last = this.pendingStreamDeltas[this.pendingStreamDeltas.length - 1];
    if (last?.kind === kind) last.text += text;
    else this.pendingStreamDeltas.push({ kind, text });
    if (this.streamFlushTimer === null) {
      // A repaint batch keeps the current message open; tool/run boundaries finish it.
      this.streamFlushTimer = setTimeout(() => this.flushStreamedDeltas(), STREAM_RENDER_INTERVAL_MS);
    }
  }

  /**
   * Turn preferences as they are right now, not as they were when the turn
   * started. Settings changed mid-run (reasoning variant, thinking visibility)
   * apply to the running turn immediately instead of waiting for it to end:
   * the next streamed delta and the next model step already see them.
   */
  private liveTurnPreferences(): AgentTurnPreferences {
    return {
      reasoningVariantId: this.runtime.reasoningDefault,
      showReasoning: this.runtime.showReasoningDefault,
    };
  }

  private flushStreamedDeltas(): void {
    if (this.streamFlushTimer !== null) clearTimeout(this.streamFlushTimer);
    this.streamFlushTimer = null;
    for (const delta of this.pendingStreamDeltas.splice(0)) {
      if (delta.kind === 'assistant') this.appendStreamedText(delta.text);
      else this.appendStreamedReasoning(delta.text);
    }
  }

  private flushStreamedEntries(): void {
    this.flushStreamedDeltas();
    const wasStreaming = this.streamedAssistantEntry !== null || this.streamedReasoningEntry !== null;
    this.streamedAssistantEntry = null;
    this.streamedReasoningEntry = null;
    if (wasStreaming) this.publish();
  }

  private onToolStart(request: ToolCallRequest, toolCallId?: string): void {
    this.flushEventAssistantText();
    this.flushStreamedEntries();
    const command = toolDisplayCommand(request);
    this.reportTurnProgress({ kind: 'tool-start', tool: toolIdentity(request) });
    const tool = toolIdentity(request);
    const preview = toolCallId ? this.previewToolEntries.get(toolCallId) : undefined;
    if (preview) {
      this.previewToolEntries.delete(toolCallId!);
      const entry: Extract<SessionEntry, { kind: 'tool' }> = { kind: 'tool', command, result: '', running: true, tool };
      this.runningToolEntry = { request, entry };
      this.replaceEntry(preview.entry, entry);
      return;
    }
    const entry: Extract<SessionEntry, { kind: 'tool' }> = { kind: 'tool', command, result: '', running: true, tool };
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
        command: running.entry.command,
        result: formatted.text || 'No output',
        running: false,
        tool,
        ...(workerSession === undefined ? {} : { session: workerSession }),
      });
      return;
    }
    const preview = toolCallId ? this.previewToolEntries.get(toolCallId) : undefined;
    if (preview) {
      this.previewToolEntries.delete(toolCallId!);
      this.replaceEntry(preview.entry, {
        kind: 'tool',
        command: preview.entry.command,
        result: formatted.text || 'No output',
        tool,
        ...(workerSession === undefined ? {} : { session: workerSession }),
      });
      return;
    }
    this.addEntry({
      kind: 'tool',
      command: toolDisplayCommand(request),
      result: formatted.text || 'No output',
      tool,
      ...(workerSession === undefined ? {} : { session: workerSession }),
    });
  }

  private onToolPreviewStart(info: { toolCallId: string; providerId: string; name: string }): void {
    // Commit buffered text but keep the assistant message open: providers can keep streaming text
    // after a tool call begins, and it belongs to the same message. Closing here split it in two.
    this.flushStreamedDeltas();
    const entry: Extract<SessionEntry, { kind: 'tool' }> = {
      kind: 'tool',
      command: toolDisplayName(info.providerId, info.name),
      result: '',
      preparing: true,
      tool: toolIdentity(info),
    };
    this.previewToolEntries.set(info.toolCallId, { entry, preview: new ToolInputPreview(), providerId: info.providerId, name: info.name });
    this.addEntry(entry);
  }

  private onToolPreviewDelta(info: { toolCallId: string; inputTextDelta: string }): void {
    const preview = this.previewToolEntries.get(info.toolCallId);
    if (!preview) return;
    preview.preview.push(info.inputTextDelta);
    const command = toolPreviewCommand(preview.providerId, preview.name, preview.preview.fields);
    const previous = preview.entry;
    if (command === previous.command) return;
    const entry: Extract<SessionEntry, { kind: 'tool' }> = { ...previous, command };
    preview.entry = entry;
    this.replaceEntry(previous, entry);
  }

  private onToolPreviewAvailable(info: { toolCallId: string; input: Record<string, unknown> }): void {
    const preview = this.previewToolEntries.get(info.toolCallId);
    if (!preview) return;
    const previous = preview.entry;
    const command = toolDisplayCommand({ providerId: preview.providerId, name: preview.name, input: info.input });
    if (command === previous.command) return;
    const entry: Extract<SessionEntry, { kind: 'tool' }> = { ...previous, command };
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
          model: this.runtime.reviewModel ?? this.runtime.model,
          request,
          messages: [...this.currentReviewMessages],
          workspaceRoot: this.runtime.workspaceRoot,
          providerOptions: this.runtime.getReviewProviderOptions(),
          ...(request.gateReason ? { gateReason: request.gateReason } : {}),
          ...(override ? { userOverride: true } : {}),
          ...(reviewTimeoutSeconds === undefined ? {} : { timeoutMs: reviewTimeoutSeconds * 1000 }),
          ...(this.currentReviewAuthorization ? { authorizedBackgroundTask: this.currentReviewAuthorization } : {}),
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

  private addUserEntry(message: QueuedMessage): void {
    this.addEntry({
      kind: 'user',
      text: message.text,
      ...(message.workspaceRoot ? { workspaceRoot: message.workspaceRoot } : {}),
      ...(message.images.length > 0 ? { imageCount: message.images.length } : {}),
      ...(message.communication ? { source: message.communication.source } : {}),
      ...(message.eventId ? { eventId: message.eventId } : {}),
    });
  }

  sendMessage(message: QueuedMessage, preferences: AgentTurnPreferences): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (message.images.length > 0 && !this.runtime.supportsVision) {
      const count = message.images.length;
      const unavailable = `[${count} image attachment${count === 1 ? '' : 's'} omitted: ${this.runtime.modelName} does not support image input.]`;
      this.addNotice(`This model cannot read images. The attachment was not sent; continuing with the text portion.`, 'warn');
      message = {
        ...message,
        text: [message.text === 'User attached image' ? '' : message.text.trim(), unavailable].filter(Boolean).join('\n\n'),
        images: [],
      };
    }
    return new Promise<void>((resolve, reject) => {
      this.queuedMessages.push({ message, preferences, resolve, reject });
      if (this.busy) this.publish();
      else {
        // An explicit send releases an Esc hold: held messages run together with this one.
        this.queueHold = false;
        void this.runQueuedMessages();
      }
    });
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
      const [{ runAgent }, { compactConversation }] = await Promise.all([import('./agent.js'), import('./compaction.js')]);
      let nextTurn: QueuedTurn | null = initialTurn;
      while (nextTurn) {
        const currentTurn = nextTurn;
        activeTurn = currentTurn;
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
        let titleRequest: { sessionId: string; message: string } | null = null;
        if (!this.sessionHasUserMessage) {
          this.sessionHasUserMessage = true;
          const imageOnly = current.images.length > 0 && current.text === 'User attached image';
          const titleSeed = imageOnly ? 'Image chat' : current.text || (current.images.length > 0 ? 'Image chat' : 'New session');
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
        this.addUserEntry(current);
        this.conversation.push(userMessage);
        if (this.conversationArchive.length > 0) this.conversationArchive.push(userMessage);
        const conversationAtRunStart = [...this.conversation];

        let refreshTools = false;
        let finalResponseReceived = false;
        let archivedResponseCount = 0;
        do {
          refreshTools = false;
          const tools = await this.runtime.registry.createModelTools({
            approve: (request, signal) => this.requestApproval(request, signal),
            approvalMode: this.runtime.approvalMode ?? 'workspace',
            autoApprove: (request) => this.options.autoApprove?.(request) ?? isToolRequestWhitelisted(this.runtime.workspaceRoot, request),
            allowToolAutoApproval: this.options.background !== true,
            ...(this.options.tools ? { allowTools: this.options.tools } : {}),
            sessionId: this.session.id,
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
              model: this.runtime.model,
              workspaceRoot: this.runtime.workspaceRoot,
              supportsVision: this.runtime.supportsVision,
              supportsImageToolResult: this.runtime.supportsImageToolResult,
              abortSignal: abortController.signal,
              messages: this.conversation,
              sessionId: this.session.id,
              ...(this.options.systemInstruction ? { systemInstruction: this.options.systemInstruction } : {}),
              compactBeforeStep: async (context) => {
                this.currentReviewMessages = context.messages;
                const recentContextGrowthTokens = this.contextGrowthThisTurn ?? growthBeforeRun;
                try {
                  const compacted = await compactConversation({
                    ...context,
                    archivePath: getDataPath(`sessions/${this.session.id}.json`),
                    model: this.runtime.model,
                    contextWindowTokens: this.runtime.contextWindowTokens,
                    outputLimitTokens: this.runtime.outputLimitTokens,
                    ...(this.lastContextUsage !== undefined ? { previousContextTokens: this.lastContextUsage } : {}),
                    ...(this.lastContextEstimate !== undefined ? { previousContextEstimateTokens: this.lastContextEstimate } : {}),
                    ...(recentContextGrowthTokens !== undefined ? { recentContextGrowthTokens } : {}),
                    onStart: () => {
                      this.flushStreamedEntries();
                      this.addNotice('Compacting the complete model context…');
                    },
                    onTextDelta: (delta) => this.queueStreamDelta('assistant', delta),
                    onReasoningDelta: (delta) => {
                      if (this.liveTurnPreferences().showReasoning) this.queueStreamDelta('reasoning', delta);
                    },
                    abortSignal: abortController.signal,
                  });
                  if (compacted) {
                    this.currentReviewMessages = compacted.messages;
                  }
                  return compacted;
                } catch (error) {
                  this.flushStreamedEntries();
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
              takeQueuedMessages: () => {
                // Steering is admitted only at SDK prepareStep, after the prior tool batch.
                // Scope/route changes remain FIFO followups so they cannot borrow an active binding.
                // Drain every compatible queued message so a burst of user input all lands in the same gap.
                const admitted: ReturnType<typeof queuedUserMessageToModelMessage>[] = [];
                for (;;) {
                  const next = this.queuedMessages[0];
                  const live = this.liveTurnPreferences();
                  if (
                    this.options.sessionWorkspaceRoot !== null ||
                    !next ||
                    (next.message.communication?.source !== 'owner-inbox' &&
                      !sameReplyRoute(current.communication?.replyTo, next.message.communication?.replyTo)) ||
                    (next.message.workspaceRoot ?? this.runtime.workspaceRoot) !== (current.workspaceRoot ?? this.runtime.workspaceRoot) ||
                    next.preferences.reasoningVariantId !== live.reasoningVariantId ||
                    next.preferences.showReasoning !== live.showReasoning
                  )
                    break;
                  this.queuedMessages.shift();
                  this.flushStreamedEntries();
                  this.flushEventAssistantText();
                  this.addUserEntry(next.message);
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
              onReasoningDelta: (delta) => {
                if (this.liveTurnPreferences().showReasoning) this.queueStreamDelta('reasoning', delta);
              },
              onConversationProgress: (conversation, responseMessages) => {
                this.conversation = conversation;
                if (this.conversationArchive.length > 0) {
                  this.conversationArchive.push(...responseMessages.slice(archivedResponseCount));
                  archivedResponseCount = responseMessages.length;
                }
              },
              onContextUsage: (inputTokens, contextEstimateTokens) => this.onContextUsage(inputTokens, contextEstimateTokens),
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
              model: this.runtime.model,
              workspaceRoot: this.runtime.workspaceRoot,
              supportsVision: this.runtime.supportsVision,
              supportsImageToolResult: this.runtime.supportsImageToolResult,
              messages: this.conversation,
              tools: {},
              maxRetries: 0,
              abortSignal: abortController.signal,
              sessionId: this.session.id,
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

        if (titleRequest && !abortController.signal.aborted) {
          const request = titleRequest;
          titleRequest = null;
          try {
            const live = this.liveTurnPreferences();
            const providerOptions = this.runtime.getReasoningProviderOptions(live.reasoningVariantId, live.showReasoning);
            const title = await generateSessionTitle(this.runtime.model, request.message, abortController.signal, providerOptions);
            if (this.session.id === request.sessionId) {
              this.session = { ...this.session, title };
              this.publish();
            }
          } catch {
            // Keep the first-message fallback when the title request is unavailable.
          }
        }
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
      reportSessionActivity(this.session.id, false);
      if (this.activeRunAbort === abortController) this.activeRunAbort = null;
      this.publish();
      // A compaction requested mid-run runs now, at the settled boundary, before
      // any newly queued turn.
      const pendingCompaction = this.pendingCompaction;
      this.pendingCompaction = null;
      if (!this.closed && pendingCompaction) {
        void this.compact(pendingCompaction.preferences, pendingCompaction.recovery, pendingCompaction.scopeRoot);
      } else if (!this.closed && !this.queueHold && this.queuedMessages.length > 0) {
        void this.runQueuedMessages();
      }
    }
  }

  async compact(preferences: AgentTurnPreferences, recovery = false, scopeRoot?: string): Promise<void> {
    if (this.closed) return;
    // Compaction rewrites the conversation, so it must not run while a turn is
    // in flight. Instead of refusing, queue it: it runs at the end of the
    // current run, after every tool result is in and the turn has settled.
    if (this.busy) {
      this.pendingCompaction = { preferences, recovery, ...(scopeRoot === undefined ? {} : { scopeRoot }) };
      this.addNotice('Compaction is queued and will run when the current run finishes.');
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
        this.session.id,
        this.runtime.supportsVision,
      );
      const tools = await this.runtime.registry.createModelTools({ approve: async () => false, onResult: () => {} });
      const result = await compactConversation({
        ...context,
        archivePath: getDataPath(`sessions/${this.session.id}.json`),
        tools: tools.tools,
        model: this.runtime.model,
        contextWindowTokens: this.runtime.contextWindowTokens,
        outputLimitTokens: this.runtime.outputLimitTokens,
        ...(this.lastContextUsage !== undefined ? { previousContextTokens: this.lastContextUsage } : {}),
        ...(this.lastContextEstimate !== undefined ? { previousContextEstimateTokens: this.lastContextEstimate } : {}),
        ...(this.contextGrowthThisTurn !== undefined ? { recentContextGrowthTokens: this.contextGrowthThisTurn } : {}),
        providerOptions: this.runtime.getReasoningProviderOptions(preferences.reasoningVariantId, preferences.showReasoning),
        onStart: () => {
          this.flushStreamedEntries();
          this.addNotice(
            recovery
              ? 'Recovering compaction: earlier reasoning is omitted from this one request; dialogue and tool data are preserved. The full transcript remains archived.'
              : 'Compacting the complete model context…',
          );
        },
        onTextDelta: (delta) => this.queueStreamDelta('assistant', delta),
        onReasoningDelta: (delta) => {
          if (preferences.showReasoning) this.queueStreamDelta('reasoning', delta);
        },
        abortSignal: abortController.signal,
        force: true,
        ...(recovery ? { recovery: true } : {}),
      });
      if (result) this.applyCompaction(result);
    } catch (error) {
      this.flushStreamedEntries();
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
    this.lastContextUsage = undefined;
    this.lastContextEstimate = undefined;
    this.contextUsageBaseline = undefined;
    this.contextGrowthThisTurn = undefined;
    const session = { ...this.session };
    delete session.contextTokens;
    delete session.contextEstimateTokens;
    delete session.contextGrowthTokens;
    this.session = session;
    this.addNotice(
      'Context compacted in one LLM request. Visible user and assistant text is preserved. Earlier reasoning and large tool payloads are covered by the checkpoint; recent tool previews retain more detail. The full transcript remains in the session archive.',
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
    (request.name !== 'subagent' && request.name !== 'subagent_poll' && request.name !== 'subagent_stop')
  ) {
    return undefined;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const session = (value as Record<string, unknown>).session;
  return typeof session === 'string' && session ? session : undefined;
}

export function toolDisplayCommand(request: Pick<ToolCallRequest, 'providerId' | 'name' | 'input'>): string {
  if (request.providerId === 'host') {
    const input = request.input;
    switch (request.name) {
      case 'execute_command':
        if (typeof input.command === 'string') return input.command;
        break;
      case 'file_read': {
        if (typeof input.path !== 'string') break;
        const offset = typeof input.offset === 'number' ? input.offset : 1;
        const range =
          typeof input.offset === 'number' || typeof input.limit === 'number'
            ? `:${offset}-${typeof input.limit === 'number' ? offset + input.limit - 1 : '…'}`
            : '';
        return `Read ${input.path}${range}`;
      }
      case 'file_write': {
        if (typeof input.path !== 'string') break;
        return `Write ${input.path}`;
      }
      case 'file_edit': {
        if (typeof input.path !== 'string') break;
        return `Edit ${input.path}`;
      }
      case 'glob': {
        if (typeof input.pattern !== 'string') break;
        const source = typeof input.path === 'string' ? ` in ${input.path}` : '';
        return `Glob ${input.pattern}${source}`;
      }
      case 'grep': {
        if (typeof input.pattern !== 'string') break;
        const source = typeof input.path === 'string' ? ` in ${input.path}` : '';
        return `Grep ${input.pattern}${source}`;
      }
      case 'question': {
        const question = clipOneLine(input.question, 80);
        if (question === undefined) break;
        const options = Array.isArray(input.options) ? input.options.filter((option): option is string => typeof option === 'string') : [];
        const shown = options
          .map((option) => clipOneLine(option, 24))
          .filter((option): option is string => option !== undefined)
          .join(' · ')
          .slice(0, 60);
        return shown ? `Ask "${question}" [${shown}]` : `Ask "${question}"`;
      }
      case 'memory_search': {
        const query = clipOneLine(input.query, 60);
        if (query === undefined) break;
        return `Search memory "${query}"`;
      }
      case 'session_list': {
        const scope = input.scope === 'workspace' ? 'workspace' : 'all';
        const limit = typeof input.limit === 'number' ? input.limit : DEFAULT_SESSION_LIST_LIMIT;
        return `Sessions ${scope} · ${limit}`;
      }
      case 'session_search': {
        const query = clipOneLine(input.query, 60);
        if (query === undefined) break;
        return `Search sessions "${query}"`;
      }
      case 'session_read': {
        if (typeof input.session !== 'string' || !input.session) break;
        const offset = typeof input.offset === 'number' ? input.offset : 1;
        const range =
          typeof input.offset === 'number' || typeof input.limit === 'number'
            ? `:${offset}-${typeof input.limit === 'number' ? offset + input.limit - 1 : '…'}`
            : '';
        return `Read session ${input.session.slice(0, 8)}${range}`;
      }
      case 'session_message': {
        if (typeof input.session !== 'string' || !input.session) break;
        const text = clipOneLine(input.text, 60);
        return text === undefined ? `Message ${input.session.slice(0, 8)}` : `Message ${input.session.slice(0, 8)} "${text}"`;
      }
      case 'parent_message': {
        const text = clipOneLine(input.text, 80);
        if (text === undefined) break;
        return `Note "${text}"`;
      }
      case 'subagent': {
        const mode = input.mode === 'explorer' ? 'explorer' : 'executor';
        const task = typeof input.task === 'string' ? input.task.replace(/\s+/g, ' ').trim() : '';
        return `subagent ${mode}${task ? ` · ${task.length > 140 ? `${task.slice(0, 140)}…` : task}` : ''}`;
      }
      case 'subagent_poll': {
        if (typeof input.session !== 'string' || !input.session) break;
        return `Poll ${input.session.slice(0, 8)}`;
      }
      case 'subagent_stop': {
        if (typeof input.session !== 'string' || !input.session) break;
        return `Stop ${input.session.slice(0, 8)}`;
      }
      case 'background_manage': {
        if (typeof input.action !== 'string') break;
        const task = typeof input.taskId === 'string' && input.taskId ? ` ${input.taskId.slice(0, 8)}` : '';
        return `Tasks ${input.action}${task}`;
      }
      case 'mcp_manage': {
        return [request.name, input.action, input.serverId].filter((part) => typeof part === 'string').join(' ');
      }
    }
  }
  return `${request.providerId}/${request.name} ${displayInputSummary(request.input)}`;
}

const MAX_DISPLAY_INPUT_CHARS = 300;

/** A bounded, redacted one-line rendering of an opaque tool input for the transcript. */
function displayInputSummary(input: Record<string, unknown>): string {
  const summary = JSON.stringify(redactSensitive(input));
  return summary.length > MAX_DISPLAY_INPUT_CHARS ? `${summary.slice(0, MAX_DISPLAY_INPUT_CHARS)}…` : summary;
}

/** A redacted, whitespace-collapsed one-liner for transcript labels; undefined when absent. */
function clipOneLine(value: unknown, maxChars: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const single = redactSensitiveText(value).replace(/\s+/g, ' ').trim();
  if (!single) return undefined;
  return single.length > maxChars ? `${single.slice(0, maxChars)}…` : single;
}

function toolDisplayName(providerId: string, name: string): string {
  return providerId === 'host' ? name : `${providerId}/${name}`;
}

/** Best available one-line label from the fields a provider has streamed so far. */
export function toolPreviewCommand(providerId: string, name: string, fields: readonly { key: string; value: string }[]): string {
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
      case 'background_manage': {
        const action = pick('action', 12);
        return action ? `Tasks ${action}` : 'background_manage';
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
}

/** Content-first display text for host tool results; undefined defers to the generic rules. */
function displayHostToolResult(name: string, result: Record<string, unknown>): { outcome: string; text: string } | undefined {
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

function queuedUserMessageToModelMessage(message: QueuedMessage): ModelMessage {
  const content: Array<{ type: 'text'; text: string } | { type: 'image'; image: string; mediaType: 'image/png' }> = [];
  const source = message.communication?.source;
  const sourceLabel =
    source === 'telegram'
      ? '[Host context: owner message via Telegram]'
      : source === 'terminal'
        ? '[Host context: owner message via terminal]'
        : source === 'owner-inbox'
          ? '[Host context: Telegram owner inbox signal]'
          : source === 'team'
            ? '[Host context: team direct message signal]'
            : '';
  const workspaceLabel = message.workspaceRoot ? `[Host context: active workspace ${message.workspaceRoot.replace(/[\r\n]/g, ' ')}]` : '';
  if (message.text || sourceLabel || workspaceLabel)
    content.push({ type: 'text', text: [sourceLabel, workspaceLabel, message.text].filter(Boolean).join('\n') });
  for (const image of message.images) content.push({ type: 'image', image: image.base64, mediaType: image.mediaType });
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
