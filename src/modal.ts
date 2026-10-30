/**
 * Modal control plane.
 *
 * OpenButler holds the owner's Modal token so it can provision GPU work on their
 * behalf. This module only answers one question — are these credentials real —
 * and it answers it by asking Modal, not by inspecting the string.
 */
import type { ModalCredentials } from './settings.js';

const API = 'https://api.modal.com/v1';

export interface ModalCheck {
  ok: boolean;
  /** Apps visible to this token, when the check succeeded. */
  apps: number | null;
  error: string | null;
}

/**
 * Verifies a token id / secret pair against the Modal API.
 *
 * Modal accepts the pair joined by a period in a Bearer header; a 200 on the app
 * list proves both halves, because either one alone is rejected.
 */
export async function verifyModalCredentials(
  credentials: ModalCredentials,
  options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<ModalCheck> {
  const doFetch = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 8000;
  let response: Response;
  try {
    response = await doFetch(`${API}/apps`, {
      headers: { authorization: `Bearer ${credentials.tokenId}.${credentials.tokenSecret}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const name = error instanceof Error ? error.name : '';
    return { ok: false, apps: null, error: name === 'TimeoutError' ? 'Modal did not answer in time.' : 'Modal could not be reached.' };
  }
  if (response.status === 401 || response.status === 403) {
    return { ok: false, apps: null, error: 'Modal rejected this token id and secret.' };
  }
  if (!response.ok) {
    return { ok: false, apps: null, error: `Modal answered ${response.status}.` };
  }
  try {
    const body: unknown = await response.json();
    const data = body && typeof body === 'object' && 'data' in body ? (body as { data: unknown }).data : null;
    return { ok: true, apps: Array.isArray(data) ? data.length : null, error: null };
  } catch {
    // A 200 with an unreadable body still proves the credentials; only the count is lost.
    return { ok: true, apps: null, error: null };
  }
}
