import type { Entry, SessionPayload } from './types.js';

type SessionState = { payload: SessionPayload | null; entries: Entry[]; base: number };
type SessionAction =
  { type: 'payload'; payload: SessionPayload } | { type: 'older'; sessionId: string; before: number; from: number; entries: Entry[] };
export function sessionReducer(state: SessionState, action: SessionAction): SessionState {
  if (action.type === 'older') {
    if (state.payload?.session.id !== action.sessionId || state.base !== action.before) return state;
    return { ...state, base: action.from, entries: [...action.entries, ...state.entries] };
  }
  const payload = action.payload;
  if (payload.reset || state.payload?.session.id !== payload.session.id) return { payload, entries: payload.entries, base: payload.from };
  const entries = state.entries.slice();
  for (const update of payload.updated ?? []) {
    const index = update.index - state.base;
    if (index >= 0 && index < entries.length) entries[index] = update.entry;
  }
  // Patches are absolute windows; ignore already-received entries after reconnects.
  const overlap = Math.max(0, state.base + entries.length - payload.from);
  return { payload, entries: [...entries, ...payload.entries.slice(overlap)], base: state.base };
}
