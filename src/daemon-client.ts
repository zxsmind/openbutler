import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { getDataPath } from './paths.js';
import { createConnection, type Socket } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import type {
  AgentSessionClient,
  AgentSessionRuntimeView,
  AgentSessionSnapshot,
  AgentSessionView,
  AgentTurnPreferences,
  ApprovalDecision,
  QueuedMessage,
} from './agent-session.js';
import { getDaemonEndpoint, startDaemon } from './daemon.js';
import {
  DAEMON_PROTOCOL_VERSION,
  MAX_DAEMON_FRAME_BYTES,
  type AttachResult,
  type DaemonEvent,
  type DaemonResponse,
  type RuntimeViewData,
  type SessionEntriesPatch,
  type SessionSnapshotData,
} from './daemon-protocol.js';
import type { SessionEntry, SessionSummary, NoticeTone } from './session-store.js';
import { LocalNoticeList, LOCAL_NOTICE_TTL_MS, MAX_LOCAL_NOTICES } from './local-notices.js';
import type { ApprovalMode } from './settings.js';
import { LOCAL_CLIENT_KINDS, type LocalClientKind } from './communication.js';

const CLIENT_CONNECT_TIMEOUT_MS = 10_000;

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

type AttachOptions = {
  chatSessionId?: string;
  newChatSession?: boolean;
  projectId?: string | null;
  clientKind?: LocalClientKind;
  custodian?: boolean;
  isolatedSession?: boolean;
  scheduleId?: string;
  /** Attach view-only to one live subagent worker session. */
  workerSessionId?: string;
  /** Attach view-only to the worker a parent session is currently blocked on. */
  runningWorkerOf?: string;
};

export async function connectDaemonSession(workspacePath: string, options: AttachOptions = {}): Promise<AgentSessionClient> {
  const workspaceRoot = realpathSync(workspacePath);
  const socket = await connectSocket();
  const client = new DaemonSessionClient(socket, workspaceRoot, options);
  try {
    await client.attach(options);
    return client;
  } catch (error) {
    client.close();
    throw error;
  }
}

class DaemonSessionClient implements AgentSessionClient {
  private input = Buffer.alloc(0);
  private readonly pending = new Map<string, PendingRequest>();
  private readonly listeners = new Set<() => void>();
  private snapshot: AgentSessionSnapshot | null = null;
  // Host patches address this array. The rendered snapshot also contains local
  // notices, whose expiry/eviction must never change the host's index space.
  private serverEntries: SessionEntry[] = [];
  private closed = false;
  private connectionFailureReported = false;
  private reconnecting = false;
  private intentionalShutdown = false;
  /**
   * Client-local notices (connection loss, IPC failures, host pings). The host
   * does not know about them, so they are merged back into the transcript at
   * the position they arrived instead of being pinned to the end: a notice
   * parked below every later message never reads as old. They expire on their
   * own, and the count is capped.
   */
  private readonly localNotices = new LocalNoticeList(MAX_LOCAL_NOTICES, LOCAL_NOTICE_TTL_MS);
  private localNoticeTimer: ReturnType<typeof setTimeout> | null = null;
  private workspaceKey: string;
  /** The host's launch entry, carried on every attach. */
  hostEntry: string | null = null;
  private savedSessions: SessionSummary[] = [];

  readonly runtime: AgentSessionRuntimeView;

  constructor(
    private socket: Socket,
    private readonly workspaceRoot: string,
    private attachOptions: AttachOptions = {},
  ) {
    const identityRoot = this.attachOptions.custodian === true ? getDataPath('custodian') : workspaceRoot;
    this.workspaceKey = process.platform === 'win32' ? identityRoot.toLocaleLowerCase('en-US') : identityRoot;
    this.runtime = {
      workspaceRoot,
      modelName: 'Connecting…',
      providerId: '',
      modelId: '',
      contextWindowTokens: null,
      supportsVision: false,
      reasoningVariants: [],
      reasoningMetadataSource: null,
      reasoningSupport: 'model-unsupported',
      reasoningDefault: 'default',
      saveReasoningPreference: (variantId) => {
        this.runtime.reasoningDefault = variantId;
        void this.request('runtime.save-reasoning', { variantId }).catch(() => {});
      },
      showReasoningDefault: true,
      saveShowReasoningPreference: (visible) => {
        this.runtime.showReasoningDefault = visible;
        void this.request('runtime.save-show-reasoning', { visible }).catch(() => {});
      },
      approvalMode: 'workspace',
      saveApprovalModePreference: (mode: ApprovalMode) => {
        const previous = this.runtime.approvalMode ?? 'workspace';
        this.runtime.approvalMode = mode;
        void this.request('runtime.save-approval-mode', { mode }).catch((error: unknown) => {
          if (this.runtime.approvalMode === mode) this.runtime.approvalMode = previous;
          this.addLocalNotice(error);
        });
      },
    };
    this.bindSocket(socket);
  }

  get isBusy(): boolean {
    return this.snapshot?.busy ?? false;
  }

  getSnapshot = (): AgentSessionSnapshot => {
    if (!this.snapshot) throw new Error('The Ranite host session has not attached yet.');
    return this.snapshot;
  };

  /**
   * The host's entries only. The merged snapshot also carries the notices this
   * client added on its own, and those sit inside the array, so a consumer that
   * addresses entries by index has to read this instead.
   */
  getServerEntries = (): readonly SessionEntry[] => {
    if (!this.snapshot) throw new Error('The Ranite host session has not attached yet.');
    return this.serverEntries;
  };

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  async attach(options: AttachOptions): Promise<void> {
    this.attachOptions = options;
    const result = await this.request<AttachResult>('attach', {
      workspaceRoot: this.workspaceRoot,
      clientKind: options.clientKind ?? 'terminal',
      ...(options.custodian ? { custodian: true } : {}),
      ...(options.chatSessionId ? { chatSessionId: options.chatSessionId } : {}),
      ...(options.newChatSession ? { newChatSession: true } : {}),
      ...(options.projectId !== undefined ? { projectId: options.projectId } : {}),
      ...(options.isolatedSession ? { isolatedSession: true } : {}),
      ...(options.scheduleId ? { scheduleId: options.scheduleId } : {}),
      ...(options.workerSessionId ? { workerSessionId: options.workerSessionId } : {}),
      ...(options.runningWorkerOf ? { runningWorkerOf: options.runningWorkerOf } : {}),
    });
    if (!isAttachResult(result)) throw new Error('The Ranite host returned an invalid session attachment.');
    this.hostEntry = typeof result.hostEntry === 'string' && result.hostEntry ? result.hostEntry : null;
    if ((options.chatSessionId || options.newChatSession) && result.sessionAttachments !== true)
      throw new Error('Restart the Ranite host to enable independent chats. The current run has been kept running.');
    if (options.chatSessionId || options.newChatSession) {
      if (typeof result.workspaceKey !== 'string') throw new Error('The host did not provide a chat binding.');
      this.workspaceKey = result.workspaceKey;
    }
    if (options.chatSessionId && result.snapshot.session.id !== options.chatSessionId)
      throw new Error('The host attached to a different chat. This connection cannot be used.');
    if (options.newChatSession) {
      const { newChatSession: _newChat, projectId: _project, ...rest } = options;
      this.attachOptions = { ...rest, chatSessionId: result.snapshot.session.id };
    }
    if (options.clientKind === 'web' && result.clientKind !== 'web')
      throw new Error('Restart the Ranite host to identify web messages correctly: ranite restart');
    if (options.custodian && result.custodian !== true)
      throw new Error(
        'The running Ranite host predates the machine-wide custodian update. Run `ranite restart` to load the installed code.',
      );
    this.applyRuntime(result.runtime);
    this.savedSessions = result.savedSessions;
    const fresh = snapshotFromData(result.snapshot);
    this.serverEntries = fresh.session.entries;
    this.snapshot = { ...fresh, session: { ...fresh.session, entries: this.withLocalNotices(fresh.session.entries) } };
    this.publish();
  }

  private bindSocket(socket: Socket): void {
    socket.setNoDelay(true);
    socket.on('data', (chunk: Buffer) => {
      if (socket === this.socket) this.consume(chunk);
    });
    socket.on('close', () => this.handleClose(new Error('Connection to the Ranite host closed.'), socket));
    socket.on('error', (error) => this.handleClose(error, socket));
  }

  addEntry(entry: SessionEntry): void {
    void this.request('session.add-entry', { entry }).catch((error: unknown) => this.addLocalNotice(error));
  }

  approveToolCall(decision: ApprovalDecision, requestId = this.snapshot?.pendingApprovalId ?? undefined): void {
    if (!requestId) return;
    void this.request('session.approve', { decision, approvalId: requestId }).catch((error: unknown) => this.addLocalNotice(error));
  }

  answerQuestion(answer: string | null, questionId = this.snapshot?.pendingQuestion?.id ?? undefined): void {
    if (!questionId) return;
    void this.request('session.answer', { answer, questionId }).catch((error: unknown) => this.addLocalNotice(error));
  }

  stop(options: { keepQueue?: boolean; holdQueue?: boolean } = {}): void {
    const payload: { keepQueue?: boolean; holdQueue?: boolean } = {};
    if (options.keepQueue === true) payload.keepQueue = true;
    if (options.holdQueue === true) {
      payload.keepQueue = true;
      payload.holdQueue = true;
    }
    void this.request('session.stop', payload).catch((error: unknown) => this.addLocalNotice(error));
  }

  sendMessage(message: QueuedMessage, preferences: AgentTurnPreferences): Promise<void> {
    return this.request('session.send', { message, preferences }).then(
      () => undefined,
      (error: unknown) => {
        const text = error instanceof Error ? error.message : String(error);
        // A view-only attachment cannot submit turns. That is a fact about the
        // attachment rather than a failed request, so the reader is told and the
        // exception does not escape into the UI.
        if (/view-only/i.test(text)) {
          this.addLocalNotice(text, 'info');
          return undefined;
        }
        throw error;
      },
    );
  }

  manageQueuedMessage(id: string, action: 'steer' | 'remove', sessionId: string): Promise<void> {
    return this.request('session.queue', { messageId: id, queueAction: action, sessionId }).then(() => undefined);
  }

  compact(preferences: AgentTurnPreferences, recovery = false): Promise<void> {
    return this.submit('session.compact', { preferences, ...(recovery ? { recovery: true } : {}) });
  }

  selectModel(providerId: string, modelId: string): Promise<void> {
    return this.request('session.select-model', { providerId, modelId }).then(() => undefined);
  }

  setApprovalMode(mode: ApprovalMode): Promise<void> {
    return this.request('runtime.save-approval-mode', { mode }).then(() => undefined);
  }

  listSessions(): Promise<SessionSummary[]> {
    return this.request<SessionSummary[]>('session.list');
  }

  loadSession(id: string): Promise<AgentSessionView | null> {
    return this.request<AgentSessionView | null>('session.load', { sessionId: id });
  }

  createNewSession(projectId?: string | null): Promise<void> {
    return this.request('session.new', projectId === undefined ? {} : { projectId }).then(() => undefined);
  }

  selectProject(projectId: string | null, sessionId: string): Promise<void> {
    return this.request('session.select-project', { projectId, sessionId }).then(() => undefined);
  }

  removeReasoningEntries(): void {
    void this.request('session.remove-reasoning').catch((error: unknown) => this.addLocalNotice(error));
  }

  flushSave(): Promise<void> {
    return this.submit('session.flush');
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.localNoticeTimer !== null) {
      clearTimeout(this.localNoticeTimer);
      this.localNoticeTimer = null;
    }
    this.socket.end();
    this.handleClose(new Error('This Ranite client detached from the host.'), this.socket);
  }

  private async request<T = unknown>(action: string, payload: Record<string, unknown> = {}): Promise<T> {
    if (this.closed || this.socket.destroyed) throw new Error('The Ranite host connection is closed.');
    const id = randomUUID();
    const request =
      JSON.stringify({
        ...payload,
        version: DAEMON_PROTOCOL_VERSION,
        id,
        action,
        ...(action === 'attach' ? {} : { workspaceKey: this.workspaceKey }),
      }) + '\n';
    if (Buffer.byteLength(request, 'utf8') > MAX_DAEMON_FRAME_BYTES) throw new Error('The request exceeded the Ranite host frame limit.');
    return new Promise<T>((resolveRequest, rejectRequest) => {
      const timer = setTimeout(
        () => {
          this.pending.delete(id);
          rejectRequest(new Error(`Ranite host request timed out: ${action}`));
        },
        action === 'attach' ? 90_000 : 30_000,
      );
      this.pending.set(id, {
        resolve: (value) => resolveRequest(value as T),
        reject: rejectRequest,
        timer,
      });
      this.socket.write(request, (error) => {
        if (!error) return;
        const pending = this.pending.get(id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(id);
        pending.reject(error);
      });
    });
  }

  private async submit(action: string, payload: Record<string, unknown> = {}): Promise<void> {
    try {
      await this.request(action, payload);
    } catch (error) {
      this.addLocalNotice(error);
    }
  }

  private consume(chunk: Buffer): void {
    if (this.input.byteLength + chunk.byteLength > MAX_DAEMON_FRAME_BYTES) {
      this.socket.destroy(new Error('Ranite host frame exceeded the 32 MB limit.'));
      return;
    }
    this.input = Buffer.concat([this.input, chunk]);
    while (true) {
      const newline = this.input.indexOf(0x0a);
      if (newline < 0) return;
      const frame = this.input.subarray(0, newline);
      this.input = this.input.subarray(newline + 1);
      let parsed: unknown;
      try {
        parsed = JSON.parse(frame.toString('utf8'));
      } catch {
        this.socket.destroy(new Error('The Ranite host sent invalid JSON.'));
        return;
      }
      if (isDaemonEvent(parsed)) {
        this.applyEvent(parsed);
        continue;
      }
      if (!isDaemonResponse(parsed)) {
        this.socket.destroy(new Error('The Ranite host sent an invalid IPC frame.'));
        return;
      }
      const pending = this.pending.get(parsed.id);
      if (!pending) {
        // A response that matches no request (for example, the host rejecting an oversized frame
        // before it could be correlated) must not vanish; surface it on the session.
        if (!parsed.ok) this.addLocalNotice(new Error(parsed.error));
        continue;
      }
      clearTimeout(pending.timer);
      this.pending.delete(parsed.id);
      if (!parsed.ok) pending.reject(new Error(parsed.error));
      else pending.resolve(parsed.result);
    }
  }

  private applyEvent(event: DaemonEvent): void {
    if (event.event === 'notification') {
      if (event.title === 'Ranite host stopping') this.intentionalShutdown = true;
      if (!event.title.trim()) {
        // An owner-directed message delivered over the terminal is content, not
        // a status ping: it becomes a session entry so it keeps its place and
        // survives a reconnect, like any other turn.
        void this.request('session.add-entry', {
          entry: { kind: 'notice', text: event.message } satisfies SessionEntry,
        }).catch((error: unknown) => this.addLocalNotice(error));
        return;
      }
      this.addLocalNotice(`${event.title}\n${event.message}`);
      return;
    }
    if (event.event === 'snapshot') {
      const fresh = snapshotFromData(event.snapshot);
      this.serverEntries = fresh.session.entries;
      this.snapshot = { ...fresh, session: { ...fresh.session, entries: this.withLocalNotices(fresh.session.entries) } };
      this.applyRuntime(event.runtime);
      this.publish();
      return;
    }
    if (!this.snapshot) return;
    const patchedEntries = applyEntriesPatch(this.serverEntries, event.patch.entriesPatch);
    this.serverEntries = patchedEntries;
    const session = { ...event.patch.session, entries: this.withLocalNotices(patchedEntries) };
    const streamingIndex = event.patch.streamingAssistantIndex;
    this.snapshot = {
      session,
      busy: event.patch.busy,
      runningTurnId: event.patch.runningTurnId,
      pendingApproval: event.patch.pendingApproval,
      pendingApprovalId: event.patch.pendingApprovalId,
      pendingQuestion: event.patch.pendingQuestion ?? null,
      queuedMessageCount: event.patch.queuedMessageCount,
      firstQueuedMessage: event.patch.firstQueuedMessage,
      queuedMessages: event.patch.queuedMessages ?? (event.patch.firstQueuedMessage ? [event.patch.firstQueuedMessage] : []),
      sessionSaveError: event.patch.sessionSaveError,
      streamingAssistantEntry: streamingIndex === null ? null : (patchedEntries[streamingIndex] ?? null),
    };
    this.applyRuntime(event.patch.runtime);
    this.publish();
  }

  private applyRuntime(data: RuntimeViewData): void {
    Object.assign(this.runtime, {
      ...data,
      ...(data.approvalMode === 'ask' ? { approvalMode: 'workspace' } : {}),
    });
  }

  private addLocalNotice(error: unknown, tone: NoticeTone = 'error'): void {
    if (!this.snapshot || this.closed) return;
    const text = error instanceof Error ? error.message : String(error);
    const notice: SessionEntry = tone === 'info' ? { kind: 'notice', text } : { kind: 'notice', text, tone };
    this.localNotices.add(notice, this.serverEntries.length);
    this.scheduleLocalNoticeExpiry();
    const current = this.snapshot;
    this.snapshot = { ...current, session: { ...current.session, entries: this.localNotices.merge(this.serverEntries) } };
    this.publish();
  }

  /** Re-publishes when the oldest notice passes its TTL, so it leaves on its own. */
  private scheduleLocalNoticeExpiry(): void {
    if (this.localNoticeTimer !== null || this.closed) return;
    this.localNoticeTimer = setTimeout(() => {
      this.localNoticeTimer = null;
      if (this.closed || !this.snapshot) return;
      if (this.localNotices.prune()) {
        this.snapshot = {
          ...this.snapshot,
          session: { ...this.snapshot.session, entries: this.localNotices.merge(this.serverEntries) },
        };
        this.publish();
      }
      if (this.localNotices.length > 0) this.scheduleLocalNoticeExpiry();
    }, LOCAL_NOTICE_TTL_MS + 50);
    this.localNoticeTimer.unref?.();
  }

  /** Merged view: server entries with the live client-local notices in their place. */
  private withLocalNotices(entries: SessionEntry[]): SessionEntry[] {
    return this.localNotices.merge(entries);
  }

  private publish(): void {
    for (const listener of this.listeners) listener();
  }

  private handleClose(error: Error, socket: Socket = this.socket): void {
    if (socket !== this.socket) return;
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
    if (!this.closed && !this.connectionFailureReported && this.snapshot) {
      this.connectionFailureReported = true;
      this.addLocalNotice(
        this.intentionalShutdown
          ? 'The Ranite host stopped. Run ranite to connect again.'
          : 'Lost connection to the Ranite host. Reconnecting…',
        this.intentionalShutdown ? 'error' : 'warn',
      );
    }
    if (!this.closed && !this.intentionalShutdown) void this.reconnect();
  }

  private async reconnect(): Promise<void> {
    if (this.reconnecting || this.closed || this.intentionalShutdown) return;
    this.reconnecting = true;
    const previousSessionId = this.snapshot?.session.id;
    const previousSessionHadUserMessage = this.snapshot?.session.entries.some((entry) => entry.kind === 'user') === true;
    let attempt = 0;
    while (!this.closed && !this.intentionalShutdown) {
      let socket: Socket | null = null;
      try {
        await startDaemon();
        socket = await connectSocket();
        if (this.closed || this.intentionalShutdown) {
          socket.destroy();
          break;
        }
        this.socket = socket;
        this.input = Buffer.alloc(0);
        this.bindSocket(socket);
        await this.attach(this.attachOptions);

        const activeSessionHasMessages = this.snapshot?.session.entries.some((entry) => entry.kind === 'user') === true;
        if (
          previousSessionId &&
          previousSessionHadUserMessage &&
          this.attachOptions.scheduleId === undefined &&
          this.snapshot?.session.id !== previousSessionId &&
          !activeSessionHasMessages &&
          this.savedSessions.some((session) => session.id === previousSessionId)
        ) {
          const restored = await this.loadSession(previousSessionId);
          if (restored && this.snapshot) {
            this.serverEntries = restored.entries;
            this.snapshot = { ...this.snapshot, session: { ...restored, entries: this.withLocalNotices(restored.entries) } };
            this.publish();
          }
        }

        this.connectionFailureReported = false;
        this.reconnecting = false;
        this.addLocalNotice('Reconnected to the Ranite host.', 'info');
        return;
      } catch {
        if (socket && !socket.destroyed) socket.destroy();
        attempt++;
        if (this.closed || this.intentionalShutdown) break;
        await delay(Math.min(5_000, 250 * 2 ** Math.min(attempt, 5)));
      }
    }
    this.reconnecting = false;
  }
}

function snapshotFromData(data: SessionSnapshotData): AgentSessionSnapshot {
  const index = data.streamingAssistantIndex;
  return {
    session: data.session,
    busy: data.busy,
    runningTurnId: data.runningTurnId,
    pendingApproval: data.pendingApproval,
    pendingApprovalId: data.pendingApprovalId,
    pendingQuestion: data.pendingQuestion ?? null,
    queuedMessageCount: data.queuedMessageCount,
    firstQueuedMessage: data.firstQueuedMessage,
    queuedMessages: data.queuedMessages ?? (data.firstQueuedMessage ? [data.firstQueuedMessage] : []),
    sessionSaveError: data.sessionSaveError,
    streamingAssistantEntry: index === null ? null : (data.session.entries[index] ?? null),
  };
}

function applyEntriesPatch(previous: SessionEntry[], patch: SessionEntriesPatch | undefined): SessionEntry[] {
  if (!patch) return previous;
  if (patch.kind === 'replace-all') return patch.entries;
  const entries = [...previous];
  for (const update of patch.appendText) {
    const entry = entries[update.index];
    if ((entry?.kind === 'assistant' || entry?.kind === 'reasoning') && typeof update.delta === 'string') {
      // Keep the rest of the entry: the server can add a field (a stamped
      // thinking duration) while the text keeps growing.
      entries[update.index] = { ...entry, text: entry.text + update.delta };
    }
  }
  for (const update of patch.replace) entries[update.index] = update.entry;
  entries.push(...patch.append);
  return entries;
}

function connectSocket(): Promise<Socket> {
  return new Promise((resolveSocket, rejectSocket) => {
    const socket = createConnection(getDaemonEndpoint());
    const timer = setTimeout(() => finish(new Error('Timed out connecting to the Ranite host.')), CLIENT_CONNECT_TIMEOUT_MS);
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.off('connect', onConnect);
      socket.off('error', onError);
      if (error) {
        socket.destroy();
        rejectSocket(error);
      } else resolveSocket(socket);
    };
    const onConnect = () => finish();
    const onError = (error: Error) => finish(error);
    socket.once('connect', onConnect);
    socket.once('error', onError);
  });
}

function isAttachResult(value: unknown): value is AttachResult {
  return (
    isRecord(value) &&
    isSessionSnapshotData(value.snapshot) &&
    isRuntimeViewData(value.runtime) &&
    Array.isArray(value.savedSessions) &&
    (value.custodian === undefined || typeof value.custodian === 'boolean') &&
    (value.clientKind === undefined || LOCAL_CLIENT_KINDS.some((kind) => kind === value.clientKind))
  );
}

function isSessionSnapshotData(value: unknown): value is SessionSnapshotData {
  return (
    isRecord(value) &&
    isRecord(value.session) &&
    Array.isArray(value.session.entries) &&
    typeof value.busy === 'boolean' &&
    (value.streamingAssistantIndex === null || Number.isSafeInteger(value.streamingAssistantIndex))
  );
}

function isRuntimeViewData(value: unknown): value is RuntimeViewData {
  return (
    isRecord(value) &&
    typeof value.workspaceRoot === 'string' &&
    typeof value.modelName === 'string' &&
    typeof value.providerId === 'string' &&
    typeof value.modelId === 'string' &&
    (value.approvalMode === undefined ||
      value.approvalMode === 'ask' ||
      value.approvalMode === 'workspace' ||
      value.approvalMode === 'auto-review' ||
      value.approvalMode === 'full-access') &&
    Array.isArray(value.reasoningVariants)
  );
}

function isDaemonResponse(value: unknown): value is DaemonResponse {
  return (
    isRecord(value) &&
    value.version === DAEMON_PROTOCOL_VERSION &&
    typeof value.id === 'string' &&
    typeof value.ok === 'boolean' &&
    (value.ok ? 'result' in value : typeof value.error === 'string')
  );
}

function isDaemonEvent(value: unknown): value is DaemonEvent {
  if (!isRecord(value) || value.version !== DAEMON_PROTOCOL_VERSION) return false;
  if (value.event === 'notification') return typeof value.title === 'string' && typeof value.message === 'string';
  if (value.event === 'snapshot') return isSessionSnapshotData(value.snapshot) && isRuntimeViewData(value.runtime);
  if (value.event === 'patch') {
    return (
      isRecord(value.patch) &&
      isRecord(value.patch.session) &&
      isRuntimeViewData(value.patch.runtime) &&
      (value.patch.entriesPatch === undefined || isEntriesPatch(value.patch.entriesPatch))
    );
  }
  return false;
}

function isEntriesPatch(value: unknown): value is SessionEntriesPatch {
  if (!isRecord(value)) return false;
  if (value.kind === 'replace-all') return Array.isArray(value.entries);
  return value.kind === 'delta' && Array.isArray(value.append) && Array.isArray(value.replace) && Array.isArray(value.appendText);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
