import { buildTurns } from '../../web/src/turns.js';
import { describe, expect, it } from 'vitest';
import { initialSessionState, sessionReducer } from '../../web/src/session-state.js';
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
    const original = sessionReducer(initialSessionState, { type: 'payload', payload: payload('a', 'A') });
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
    const initial = sessionReducer(initialSessionState, { type: 'payload', payload: payload('a', 'first') });
    const patch = {
      ...payload('a', 'second'),
      reset: false,
      from: 11,
      updated: [{ index: 10, entry: { kind: 'user', text: 'corrected' } }],
    };
    const changed = sessionReducer(initial, { type: 'payload', payload: patch });
    const repeated = sessionReducer(changed, { type: 'payload', payload: patch });
    expect(changed.behind).toBe(false);
    expect(repeated.entries.map((entry) => entry.text)).toEqual(['corrected', 'second']);
  });
  it('a reset replaces the window instead of keeping a stale prefix', () => {
    // The host can remove entries below this window (reasoning is removable), so
    // every index after the removal shifts. Keeping a local prefix by index would
    // leave stale entries in front of the new window, and the next index-addressed
    // update would overwrite the wrong message.
    const wide = Array.from({ length: 150 }, (_, index) => ({ kind: 'user', text: `e${index}` }));
    const started = sessionReducer(initialSessionState, {
      type: 'payload',
      payload: { ...payload('a', 'start'), reset: true, from: 0, entries: wide },
    });
    const reset = sessionReducer(started, {
      type: 'payload',
      payload: { ...payload('a', 'after removal'), reset: true, from: 49, entries: [{ kind: 'user', text: 'h49' }] },
    });
    expect(reset.base).toBe(49);
    expect(reset.entries.map((entry) => entry.text)).toEqual(['h49']);
  });

  it('asks for a fresh snapshot instead of appending across a lost patch', () => {
    // A patch that starts past the local end means entries in between never
    // arrived. Appending it would leave a hole, and every later index-addressed
    // update would land on the wrong entry — a streamed answer that stalls and
    // then jumps once a snapshot finally arrives.
    const initial = sessionReducer(initialSessionState, { type: 'payload', payload: payload('a', 'first') });
    const gapped = sessionReducer(initial, {
      type: 'payload',
      payload: {
        ...payload('a', 'later'),
        reset: false,
        from: 14,
        entries: [{ kind: 'tool', command: 'read' }],
        updated: [{ index: 15, entry: { kind: 'assistant', text: 'never shown' } }],
      },
    });
    expect(gapped.behind).toBe(true);
    // The list is left exactly as it was: no hole, nothing dropped silently.
    expect(gapped.entries).toEqual(initial.entries);

    const healed = sessionReducer(gapped, { type: 'payload', payload: payload('a', 'fresh') });
    expect(healed.behind).toBe(false);
    expect(healed.entries.map((entry) => entry.text)).toEqual(['fresh']);
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
