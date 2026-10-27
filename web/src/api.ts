import type {
  ActionsReport,
  AboutInfo,
  ApprovalsInfo,
  LogRecord,
  ApprovalMode,
  DraftImage,
  Entry,
  MemoryInfo,
  ModelChoice,
  ModelCatalogRow,
  ModalInfo,
  ProviderCatalogRow,
  SessionInfo,
  SessionPayload,
  TelegramInfo,
  UsageHoursReport,
  UsageReport,
} from './types.js';

import type { Project, ProjectCatalog } from './types.js';
import type { WorkspaceFiles, WorkspaceFileTree } from '../../src/web/files-protocol.js';

async function request<T>(path: string, body?: unknown): Promise<T> {
  const context = body && typeof body === 'object' ? (body as { currentSessionId?: unknown; sessionId?: unknown }) : null;
  const sessionId =
    typeof context?.currentSessionId === 'string'
      ? context.currentSessionId
      : typeof context?.sessionId === 'string'
        ? context.sessionId
        : undefined;
  const response = await fetch(
    path,
    body === undefined
      ? undefined
      : {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...(sessionId ? { 'x-ranite-session': sessionId } : {}) },
          body: JSON.stringify(body),
        },
  ).catch(() => {
    throw new Error('Unable to reach Ranite. Check your connection and try again.');
  });
  if (!response.ok) {
    let detail =
      response.status === 404
        ? 'This content is currently unavailable. Try refreshing the page.'
        : response.status === 429
          ? 'Please wait a moment before trying again.'
          : 'Ranite could not complete this request. Please try again.';
    try {
      const data: unknown = await response.json();
      if (data && typeof data === 'object' && 'error' in data && typeof data.error === 'string') detail = data.error;
    } catch {
      /* Keep the HTTP error. */
    }
    throw new Error(detail);
  }
  return response.json() as Promise<T>;
}
export const sendMessage = (text: string, sessionId: string, images: DraftImage[] = [], reasoningVariantId?: string) =>
  request('/api/message', {
    text,
    sessionId,
    images: images.map(({ base64, mediaType }) => ({ base64, mediaType })),
    reasoningVariantId,
  });
export const fetchProjects = () => request<ProjectCatalog>('/api/projects');
export const createProject = (name: string, folders: string[]) => request<Project>('/api/projects', { name, folders });
export const validateProjectFolder = (path: string) => request<{ path: string }>('/api/project-folders', { path });
export const pickProjectFolder = () => request<{ path: string | null }>('/api/project-folder-picker', {});
export const changeSessionProject = (sessionId: string, projectId: string | null) =>
  request<SessionPayload>('/api/session-project', { sessionId, projectId });
export const stopRun = (sessionId: string) => request('/api/stop', { holdQueue: true, sessionId });
export const manageQueuedMessage = (sessionId: string, messageId: string, action: 'steer' | 'remove') =>
  request('/api/queue', { sessionId, messageId, action });
export const decideApproval = (decision: 'allow' | 'deny' | 'always', sessionId: string, requestId?: string) =>
  request('/api/approve', { decision, requestId, sessionId });
export const answerQuestion = (answer: string | null, sessionId: string, questionId?: string) =>
  request('/api/answer', { answer, questionId, sessionId });
export const fetchSessions = () => request<SessionInfo[]>('/api/sessions');
export const fetchWorkspaceFiles = (sessionId: string, path: string) =>
  request<WorkspaceFiles>(`/api/files?${new URLSearchParams({ sessionId, path })}`);
export const fetchWorkspaceFileTree = (sessionId: string) =>
  request<WorkspaceFileTree>(`/api/files/tree?${new URLSearchParams({ sessionId })}`);
export const fetchModels = () => request<ModelChoice[]>('/api/models');
export const fetchModelCatalog = () => request<ModelCatalogRow[]>('/api/models/catalog');
export const setModelActive = (providerId: string, modelId: string, active: boolean) =>
  request<ModelCatalogRow[]>('/api/models/active', { providerId, modelId, active });
export const fetchProviderCatalog = () => request<ProviderCatalogRow[]>('/api/providers');
export const fetchModal = () => request<ModalInfo>('/api/modal');
export const saveModal = (tokenId: string, tokenSecret: string) => request<ModalInfo>('/api/modal', { tokenId, tokenSecret });
export const clearModal = () => request<ModalInfo>('/api/modal/clear', {});
export const removeProvider = (providerId: string) => request<ModelCatalogRow[]>('/api/providers/remove', { providerId });
export const addProvider = (providerId: string, options: { apiKey?: string; npm?: string; url?: string; model?: string }) =>
  request<ModelCatalogRow[]>('/api/providers', { providerId, ...options });
export const changeSession = (currentSessionId: string, sessionId?: string, projectId?: string | null) =>
  request<SessionPayload>(
    '/api/session',
    sessionId
      ? { action: 'load', sessionId, currentSessionId }
      : { action: 'new', currentSessionId, ...(projectId === undefined ? {} : { projectId }) },
  );
export const changeModel = (model: ModelChoice, sessionId: string) => request<SessionPayload>('/api/model', { ...model, sessionId });
export const changeApprovalMode = (mode: ApprovalMode, sessionId: string) =>
  request<SessionPayload>('/api/approval-mode', { mode, sessionId });
export const fetchOlder = (before: number, sessionId: string, limit = 50) =>
  request<{ sessionId: string; from: number; to: number; entries: Entry[] }>(
    `/api/entries?before=${before}&limit=${limit}&sessionId=${encodeURIComponent(sessionId)}`,
  );

/** The server sends a heartbeat every 15 s; three missed ones mean the stream is dead. */
const STALE_MS = 45_000;

export function subscribe(
  onPayload: (payload: SessionPayload) => void,
  onStatus: (status: 'open' | 'error') => void,
  sessionId?: string,
  onSessionsChanged?: () => void,
  onModelsChanged?: () => void,
): () => void {
  // Liveness comes from the server's heartbeat event; a stream that keeps
  // delivering is never torn down.
  let lastSeen = 0;
  const handle = (event: MessageEvent<string>) => {
    lastSeen = Date.now();
    try {
      onPayload(JSON.parse(event.data) as SessionPayload);
    } catch {
      /* A malformed frame cannot break the stream. */
    }
  };
  let source: EventSource | null = null;
  let timer: number | null = null;
  let attempt = 0;
  let stopped = false;

  const connect = () => {
    if (stopped || source) return;
    const stream = new EventSource(`/api/events${sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ''}`);
    source = stream;
    stream.addEventListener('open', () => {
      attempt = 0;
      lastSeen = Date.now();
      onStatus('open');
    });
    stream.addEventListener('ping', () => {
      lastSeen = Date.now();
    });
    stream.addEventListener('snapshot', handle as EventListener);
    stream.addEventListener('patch', handle as EventListener);
    stream.addEventListener('sessions-changed', () => onSessionsChanged?.());
    stream.addEventListener('models-changed', () => onModelsChanged?.());
    stream.addEventListener('error', () => {
      onStatus('error');
      // Why a stream ended is the question that matters: the ready state and how
      // long it had been silent separate a server-side close from a dead network.
      reportClientEvent('stream-error', { readyState: stream.readyState, silentMs: lastSeen === 0 ? -1 : Date.now() - lastSeen });
      // The browser retries a broken stream on its own, but a phone that was
      // suspended or a proxy that answered badly can leave it retrying forever.
      // Rebuild the stream from scratch, backing off so a dead server is not
      // hammered.
      stream.close();
      if (source === stream) source = null;
      if (stopped) return;
      const delay = Math.min(10_000, 500 * 2 ** attempt);
      attempt += 1;
      if (timer !== null) clearTimeout(timer);
      timer = window.setTimeout(connect, delay);
    });
  };

  const resume = () => {
    if (document.visibilityState !== 'visible') return;
    // A stream that is still open and has delivered something recently is left
    // alone. Rebuilding it on every tab switch replaces the reader's list with
    // a fresh snapshot, which is what made a running answer appear to jump.
    if (source && source.readyState !== EventSource.CLOSED && Date.now() - lastSeen < STALE_MS) return;
    source?.close();
    source = null;
    attempt = 0;
    connect();
  };

  document.addEventListener('visibilitychange', resume);
  window.addEventListener('online', resume);
  connect();

  return () => {
    stopped = true;
    if (timer !== null) clearTimeout(timer);
    document.removeEventListener('visibilitychange', resume);
    window.removeEventListener('online', resume);
    source?.close();
    source = null;
  };
}
export const fetchUsage = (days: number) => request<UsageReport>(`/api/usage?days=${days}`);
export const fetchUsageActions = (days: number) => request<ActionsReport>(`/api/usage-actions?days=${days}`);
export const fetchSnapshot = (sessionId?: string) =>
  request<SessionPayload>(`/api/snapshot${sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ''}`);
/**
 * Diagnostics only: the browser reports what the server cannot see about it.
 * Failures are ignored, because a report must never disturb the reader.
 */
export const reportClientEvent = (event: string, fields: Record<string, unknown> = {}) => {
  void fetch('/api/client-report', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ event, ...fields }),
  }).catch(() => {
    /* A dropped report is not a reader problem. */
  });
};
export const fetchUsageHours = (hours = 48) => request<UsageHoursReport>(`/api/usage/hours?hours=${hours}`);
export const fetchMemory = () => request<MemoryInfo>('/api/memory');
export const fetchLogs = (level: string, lines = 200) =>
  request<{ records: LogRecord[] }>(`/api/logs?level=${level}&lines=${lines}`).then((page) => page.records);
export const fetchAbout = () => request<AboutInfo>('/api/about');
export const fetchTelegram = () => request<TelegramInfo>('/api/telegram');
export const fetchApprovals = () => request<ApprovalsInfo>('/api/approvals');
export const setAutoReview = (value: { providerId: string | null; modelId: string | null; timeoutSeconds?: number | null }) =>
  request<{ ok: true }>('/api/approvals/auto-review', value);
export const forgetPermission = (id: string) => request<{ removed: boolean }>('/api/approvals/forget', { id });
