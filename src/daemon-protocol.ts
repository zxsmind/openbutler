import type { AgentSessionRuntimeView, AgentSessionSnapshot, AgentSessionView } from './agent-session.js';
import type { SessionEntry, SessionSummary } from './session-store.js';
import type { TelegramStatus } from './telegram.js';
import type { ApprovalMode } from './settings.js';
import type { LocalClientKind } from './communication.js';

export const DAEMON_PROTOCOL_VERSION = 2;
export const MAX_DAEMON_FRAME_BYTES = 32 * 1024 * 1024;

export type DaemonStatus = {
  pid: number;
  startedAt: string;
  workspaceCount: number;
  connectedClients: number;
  schedules?: number;
  telegram?: TelegramStatus;
  /** Present only when a newer CLI discovered an older still-running host. */
  legacy?: true;
  /** PID is still alive, but IPC is unavailable. Counts in this state are unknown. */
  unresponsive?: true;
};

export type RuntimeViewData = Omit<
  AgentSessionRuntimeView,
  'saveReasoningPreference' | 'saveShowReasoningPreference' | 'saveApprovalModePreference' | 'approvalMode'
> & {
  /** `ask` is accepted only for migration from an already-running older host. */
  approvalMode?: ApprovalMode | 'ask';
};

export type SessionSnapshotData = Omit<AgentSessionSnapshot, 'streamingAssistantEntry'> & {
  firstQueuedMessage: { text: string; imageCount: number } | null;
  streamingAssistantIndex: number | null;
};

export type SessionEntriesPatch =
  | {
      kind: 'delta';
      append: SessionEntry[];
      replace: Array<{ index: number; entry: SessionEntry }>;
      appendText: Array<{ index: number; delta: string }>;
    }
  | { kind: 'replace-all'; entries: SessionEntry[] };

export type SessionPatchData = {
  session: Omit<AgentSessionView, 'entries'>;
  entriesPatch?: SessionEntriesPatch;
  busy: boolean;
  pendingApproval: AgentSessionSnapshot['pendingApproval'];
  pendingApprovalId: string | null;
  pendingQuestion: AgentSessionSnapshot['pendingQuestion'];
  queuedMessageCount: number;
  firstQueuedMessage: { text: string; imageCount: number } | null;
  queuedMessages: AgentSessionSnapshot['queuedMessages'];
  sessionSaveError: string | null;
  streamingAssistantIndex: number | null;
  runtime: RuntimeViewData;
};

export type DaemonEvent =
  | { version: 2; event: 'snapshot'; snapshot: SessionSnapshotData; runtime: RuntimeViewData }
  | { version: 2; event: 'patch'; patch: SessionPatchData }
  | DaemonNotification;
// Notifications are owner messages; they are not model conversation patches.
export type DaemonNotification = { version: 2; event: 'notification'; title: string; message: string };

export type DaemonResponse = { version: 2; id: string; ok: true; result: unknown } | { version: 2; id: string; ok: false; error: string };

export type DaemonRequest = { version: 2; id: string; action: string; [key: string]: unknown };

export interface AttachResult {
  /** The host can attach to a conversation without replacing another controller. */
  sessionAttachments?: true;
  workspaceKey?: string;
  /** Source identity accepted for this local IPC connection. */
  clientKind?: LocalClientKind;
  snapshot: SessionSnapshotData;
  runtime: RuntimeViewData;
  savedSessions: SessionSummary[];
  /** Present on hosts that support the machine-wide custodian identity. */
  custodian?: boolean;
}
