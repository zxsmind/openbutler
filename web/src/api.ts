import type { DraftImage, Entry, ModelChoice, SessionInfo, SessionPayload } from './types.js';

async function request<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(
    path,
    body === undefined
      ? undefined
      : {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        },
  );
  if (!response.ok) {
    let detail = `Request failed (${response.status}).`;
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
  request('/api/message', { text, sessionId, images: images.map(({ base64, mediaType }) => ({ base64, mediaType })), reasoningVariantId });
export const stopRun = () => request('/api/stop', { holdQueue: true });
export const decideApproval = (decision: 'allow' | 'deny' | 'always', requestId?: string) =>
  request('/api/approve', { decision, requestId });
export const answerQuestion = (answer: string | null, questionId?: string) => request('/api/answer', { answer, questionId });
export const fetchSessions = () => request<SessionInfo[]>('/api/sessions');
export const fetchModels = () => request<ModelChoice[]>('/api/models');
export const changeSession = (currentSessionId: string, sessionId?: string) =>
  request<SessionPayload>(
    '/api/session',
    sessionId ? { action: 'load', sessionId, currentSessionId } : { action: 'new', currentSessionId },
  );
export const changeModel = (model: ModelChoice, sessionId: string) => request<SessionPayload>('/api/model', { ...model, sessionId });
export const fetchOlder = (before: number, sessionId: string, limit = 50) =>
  request<{ sessionId: string; from: number; to: number; entries: Entry[] }>(
    `/api/entries?before=${before}&limit=${limit}&sessionId=${encodeURIComponent(sessionId)}`,
  );

export function subscribe(onPayload: (payload: SessionPayload) => void, onStatus: (status: 'open' | 'error') => void): () => void {
  const source = new EventSource('/api/events');
  const handle = (event: MessageEvent<string>) => {
    try {
      onPayload(JSON.parse(event.data) as SessionPayload);
    } catch {
      /* A malformed frame cannot break the stream. */
    }
  };
  source.addEventListener('open', () => onStatus('open'));
  source.addEventListener('snapshot', handle as EventListener);
  source.addEventListener('patch', handle as EventListener);
  source.addEventListener('error', () => onStatus('error'));
  return () => source.close();
}
