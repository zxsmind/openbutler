import type { Entry, SessionPayload } from './types.js';
import { appendReveal } from './stream-reveal.js';
import { normalizeLatexMath } from './latex-math.js';

/** Normalize an entry's text on its way into state, so the renderer and the
 * reveal ranges both work on one consistent string. Tool output stays verbatim:
 * its backslashes are content, not markup. */
function normalizeEntry(entry: Entry): Entry {
  if (entry.kind === 'tool' || typeof entry.text !== 'string') return entry;
  const text = normalizeLatexMath(entry.text);
  return text === entry.text ? entry : { ...entry, text };
}

function revealEntry(entry: Entry, previous: Entry | undefined, receivedAt: number | undefined): Entry {
  const normalized = normalizeEntry(entry);
  if (receivedAt === undefined) return normalized;
  if (normalized.kind !== 'assistant' && normalized.kind !== 'reasoning' && normalized.kind !== 'tool') return normalized;
  const field = normalized.kind === 'tool' ? 'result' : 'text';
  return {
    ...normalized,
    streamReveal: appendReveal(previous?.[field] ?? '', normalized[field] ?? '', previous?.streamReveal ?? [], receivedAt),
  };
}

type SessionState = {
  payload: SessionPayload | null;
  entries: Entry[];
  base: number;
  behind: boolean;
  /** The patch that could not be applied, kept so the client can report it. */
  gap: { from: number; base: number; length: number } | null;
};
type SessionAction =
  | { type: 'payload'; payload: SessionPayload; receivedAt?: number }
  // Several stream patches applied as one render: a phone cannot keep up with one
  // render per token, and the patches are ordered, so they are replayed in order.
  | { type: 'payloads'; payloads: { payload: SessionPayload; receivedAt: number }[] }
  | { type: 'older'; sessionId: string; before: number; from: number; entries: Entry[] };

export const initialSessionState: SessionState = { payload: null, entries: [], base: 0, behind: false, gap: null };

function applyPayload(state: SessionState, payload: SessionPayload, receivedAt?: number): SessionState {
  if (state.payload?.session.id !== payload.session.id)
    return { payload, entries: payload.entries.map(normalizeEntry), base: payload.from, behind: false, gap: null };
  if (payload.reset) {
    // A reset is authoritative. The host can remove entries below this window —
    // reasoning is removable, compaction rewrites the conversation — and every
    // index after such a change shifts. Keeping a local prefix by index would
    // leave stale entries in front of the new window, so the next index-addressed
    // update would overwrite a message that is still there. Older history is not
    // lost: the reader pages it back on demand, by absolute index.
    return { payload, entries: payload.entries.map(normalizeEntry), base: payload.from, behind: false, gap: null };
  }
  // A patch continues exactly where the local list ends. A higher `from` means
  // entries in between never arrived: appending anyway would leave a hole and
  // every later index-addressed update would land on the wrong entry, which is
  // how a streamed answer stalls and then jumps. Ask for a fresh snapshot.
  if (payload.from > state.base + state.entries.length)
    return { ...state, behind: true, gap: { from: payload.from, base: state.base, length: state.entries.length } };
  const entries = state.entries.slice();
  for (const update of payload.updated ?? []) {
    const index = update.index - state.base;
    if (index >= 0 && index < entries.length) entries[index] = revealEntry(update.entry, entries[index], receivedAt);
  }
  // Patches are absolute windows; ignore already-received entries after reconnects.
  const overlap = Math.max(0, state.base + entries.length - payload.from);
  return {
    payload,
    entries: [...entries, ...payload.entries.slice(overlap).map((entry) => revealEntry(entry, undefined, receivedAt))],
    base: state.base,
    behind: false,
    gap: null,
  };
}

export function sessionReducer(state: SessionState, action: SessionAction): SessionState {
  if (action.type === 'older') {
    if (state.payload?.session.id !== action.sessionId || state.base !== action.before) return state;
    return { ...state, base: action.from, entries: [...action.entries.map(normalizeEntry), ...state.entries] };
  }
  if (action.type === 'payloads')
    return action.payloads.reduce((current, item) => applyPayload(current, item.payload, item.receivedAt), state);
  return applyPayload(state, action.payload, action.receivedAt);
}
