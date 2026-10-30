const DRAFT_PREFIX = 'openbutler:draft:';

export function readDrafts(storage: Storage): Record<string, string> {
  const drafts: Record<string, string> = {};
  try {
    for (let index = 0; index < storage.length; index++) {
      const key = storage.key(index);
      if (key?.startsWith(DRAFT_PREFIX)) drafts[key.slice(DRAFT_PREFIX.length)] = storage.getItem(key) ?? '';
    }
  } catch {
    // Storage may be unavailable; drafts still work for the lifetime of the tab.
  }
  return drafts;
}

export function saveDraft(storage: Storage, sessionId: string, text: string): void {
  if (!sessionId) return;
  try {
    if (text) storage.setItem(DRAFT_PREFIX + sessionId, text);
    else storage.removeItem(DRAFT_PREFIX + sessionId);
  } catch {
    // A full or blocked store must not prevent editing or sending a message.
  }
}

export interface ComposerHistory {
  messages: readonly string[];
  index: number;
  draft: string;
}

export function moveHistory(
  current: ComposerHistory | null,
  messages: readonly string[],
  draft: string,
  direction: -1 | 1,
): ComposerHistory | null {
  if (!current && (direction === 1 || !messages.length)) return null;
  const history = current ?? { messages: [...messages], index: messages.length, draft };
  return { ...history, index: Math.max(0, Math.min(history.messages.length, history.index + direction)) };
}
