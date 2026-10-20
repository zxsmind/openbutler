import { buildTurns } from '../../web/src/turns.js';
import { describe, expect, it } from 'vitest';
import { sessionReducer } from '../../web/src/session-state.js';
import type { SessionPayload } from '../../web/src/types.js';
const payload = (id: string, text: string): SessionPayload => ({
  reset: true,
  session: { id, title: id },
  entries: [{ kind: 'user', text }],
  updated: [],
  from: 10,
  totalEntries: 11,
  busy: false,
  queuedMessageCount: 0,
  pendingApproval: null,
  pendingQuestion: null,
});
describe('browser transcript state', () => {
  it('discards an in-flight history page after switching chats', () => {
    const original = sessionReducer({ payload: null, base: 0, entries: [] }, { type: 'payload', payload: payload('a', 'A') });
    const switched = sessionReducer(original, { type: 'payload', payload: payload('b', 'B') });
    const late = sessionReducer(switched, {
      type: 'older',
      sessionId: 'a',
      before: 10,
      from: 0,
      entries: [{ kind: 'user', text: 'old A' }],
    });
    expect(late).toBe(switched);
    expect(late.entries).toEqual([{ kind: 'user', text: 'B' }]);
  });
  it('applies absolute replacements and does not append a repeated patch twice', () => {
    const initial = sessionReducer({ payload: null, base: 0, entries: [] }, { type: 'payload', payload: payload('a', 'first') });
    const patch = {
      ...payload('a', 'second'),
      reset: false,
      from: 11,
      updated: [{ index: 10, entry: { kind: 'user', text: 'corrected' } }],
    };
    const changed = sessionReducer(initial, { type: 'payload', payload: patch });
    const repeated = sessionReducer(changed, { type: 'payload', payload: patch });
    expect(repeated.entries.map((entry) => entry.text)).toEqual(['corrected', 'second']);
  });
});

it('preserves assistant and tool chronology within a turn', () => {
  const entries = [
    { kind: 'user', text: 'Task' },
    { kind: 'assistant', text: 'Starting' },
    { kind: 'tool', command: 'read' },
    { kind: 'assistant', text: 'Result' },
  ];
  expect(buildTurns(entries)[0].timeline).toEqual(entries.slice(1));
});
