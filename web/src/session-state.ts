import type { Entry, SessionPayload } from './types.js';

type SessionState = {
  payload: SessionPayload | null;
  entries: Entry[];
  base: number;
  behind: boolean;
  /** The patch that could not be applied, kept so the client can report it. */
  gap: { from: number; base: number; length: number } | null;
};
type SessionAction =
  | { type: 'payload'; payload: SessionPayload }
  // Several stream patches applied as one render: a phone cannot keep up with one
  // render per token, and the patches are ordered, so they are replayed in order.
  | { type: 'payloads'; payloads: SessionPayload[] }
  | { type: 'older'; sessionId: string; before: number; from: number; entries: Entry[] };

export const initialSessionState: SessionState = { payload: null, entries: [], base: 0, behind: false, gap: null };

function applyPayload(state: SessionState, payload: SessionPayload): SessionState {
  if (state.payload?.session.id !== payload.session.id)
    return { payload, entries: payload.entries, base: payload.from, behind: false, gap: null };
  if (payload.reset) {
    // A reset is authoritative. The host can remove entries below this window —
    // reasoning is removable, compaction rewrites the conversation — and every
    // index after such a change shifts. Keeping a local prefix by index would
    // leave stale entries in front of the new window, so the next index-addressed
    // update would overwrite a message that is still there. Older history is not
    // lost: the reader pages it back on demand, by absolute index.
    return { payload, entries: payload.entries, base: payload.from, behind: false, gap: null };
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
    if (index >= 0 && index < entries.length) entries[index] = update.entry;
  }
  // Patches are absolute windows; ignore already-received entries after reconnects.
  const overlap = Math.max(0, state.base + entries.length - payload.from);
  return { payload, entries: [...entries, ...payload.entries.slice(overlap)], base: state.base, behind: false, gap: null };
}

export function sessionReducer(state: SessionState, action: SessionAction): SessionState {
  if (action.type === 'older') {
    if (state.payload?.session.id !== action.sessionId || state.base !== action.before) return state;
    return { ...state, base: action.from, entries: [...action.entries, ...state.entries] };
  }
  if (action.type === 'payloads') return action.payloads.reduce(applyPayload, state);
  return applyPayload(state, action.payload);
}
