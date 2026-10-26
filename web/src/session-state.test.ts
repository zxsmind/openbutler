import { describe, expect, it } from 'vitest';
import { initialSessionState, sessionReducer } from './session-state.js';
import type { Entry, SessionPayload } from './types.js';

const payload = (session: string, entries: Entry[], overrides: Partial<SessionPayload> = {}): SessionPayload => ({
  reset: false,
  entries,
  updated: [],
  from: 0,
  totalEntries: entries.length,
  busy: false,
  runningTurnId: null,
  queuedMessageCount: 0,
  pendingApproval: null,
  pendingQuestion: null,
  session: { id: session, title: 'Test' },
  ...overrides,
});

describe('session state LaTeX normalization', () => {
  it('rewrites inline LaTeX delimiters to dollars when a payload arrives', () => {
    const state = sessionReducer(initialSessionState, {
      type: 'payload',
      payload: payload('inline', [{ kind: 'assistant', text: 'Çözüm: \\(x^2 - 4 = 0\\).' }]),
    });
    expect(state.entries[0].text).toBe('Çözüm: $x^2 - 4 = 0$.');
  });

  it('turns a sole display delimiter paragraph into a display block', () => {
    const state = sessionReducer(initialSessionState, {
      type: 'payload',
      payload: payload('display', [{ kind: 'assistant', text: '\\[E = mc^2\\]' }]),
    });
    expect(state.entries[0].text).toBe('$$\nE = mc^2\n$$');
  });

  it('leaves delimiters inside code spans and fences verbatim', () => {
    const source = 'Inline `\\(x\\)` stays code.\n\n```tex\n\\[y\\]\n```';
    const state = sessionReducer(initialSessionState, {
      type: 'payload',
      payload: payload('code', [{ kind: 'assistant', text: source }]),
    });
    expect(state.entries[0].text).toBe(source);
  });

  it('normalizes user entries as they enter state', () => {
    const state = sessionReducer(initialSessionState, {
      type: 'payload',
      payload: payload('user', [{ kind: 'user', text: 'solve \\(a+b\\)' }]),
    });
    expect(state.entries[0].text).toBe('solve $a+b$');
  });

  it('keeps tool results verbatim', () => {
    const state = sessionReducer(initialSessionState, {
      type: 'payload',
      payload: payload('tool', [{ kind: 'tool', tool: 'Bash', result: 'echo \\(x\\)' }]),
    });
    expect(state.entries[0].result).toBe('echo \\(x\\)');
  });

  it('normalizes streamed updates before the reveal range is measured', () => {
    const initial = sessionReducer(initialSessionState, {
      type: 'payload',
      payload: payload('stream', [{ kind: 'assistant', text: '' }]),
    });
    const state = sessionReducer(initial, {
      type: 'payload',
      receivedAt: 1000,
      payload: payload('stream', [], {
        updated: [{ index: 0, entry: { kind: 'assistant', text: '\\(x\\)' } }],
      }),
    });
    expect(state.entries[0].text).toBe('$x$');
    expect(state.entries[0].streamReveal).toBeDefined();
  });

  it('normalizes an authoritative reset window', () => {
    const initial = sessionReducer(initialSessionState, {
      type: 'payload',
      payload: payload('reset', [{ kind: 'assistant', text: 'old \\(x\\)' }]),
    });
    const state = sessionReducer(initial, {
      type: 'payload',
      payload: payload('reset', [{ kind: 'assistant', text: 'fresh \\(z\\)' }], { reset: true }),
    });
    expect(state.entries[0].text).toBe('fresh $z$');
  });

  it('normalizes paged history on the older action', () => {
    const initial = sessionReducer(initialSessionState, {
      type: 'payload',
      payload: payload('older', [{ kind: 'assistant', text: 'late \\(x\\)' }], { from: 2 }),
    });
    const state = sessionReducer(initial, {
      type: 'older',
      sessionId: 'older',
      before: 2,
      from: 0,
      entries: [{ kind: 'assistant', text: 'first \\(y\\)' }],
    });
    expect(state.entries[0].text).toBe('first $y$');
    expect(state.entries[1].text).toBe('late $x$');
  });
});
