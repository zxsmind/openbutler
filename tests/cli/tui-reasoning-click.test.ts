import { PassThrough, Writable } from 'node:stream';
import { createElement } from 'react';
import { render } from 'ink';
import { describe, expect, it } from 'vitest';
import { SessionScreen, createMouseInputBridge } from '../../src/cli/terminal-session.js';
import type { AgentSessionClient, AgentSessionSnapshot } from '../../src/agent-session.js';
import type { SessionEntry } from '../../src/session-store.js';

const WIDTH = 100;
const ROWS = 40;
const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]/g;

class Sink extends Writable {
  text = '';
  constructor() {
    super();
    Object.assign(this, { isTTY: true, columns: WIDTH, rows: ROWS });
  }
  override _write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.text += String(chunk);
    callback();
  }
  since(mark: number): string {
    return this.text.slice(mark).replace(ANSI, '');
  }
}

function fakeClient(entries: SessionEntry[]): AgentSessionClient {
  const snapshot: AgentSessionSnapshot = {
    session: {
      id: 'fixture',
      title: 'fixture',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      providerId: 'fixture',
      modelId: 'fixture',
      entries,
    } as AgentSessionSnapshot['session'],
    busy: false,
    pendingApproval: null,
    pendingApprovalId: null,
    pendingQuestion: null,
    queuedMessageCount: 0,
    firstQueuedMessage: null,
    queuedMessages: [],
    sessionSaveError: null,
    streamingAssistantEntry: null,
  };
  const noop = async () => {};
  return {
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
    runtime: {
      provider: 'fixture',
      model: 'fixture',
      workspaceRoot: process.cwd(),
      approvalMode: 'workspace',
      supportsVision: false,
      reasoningVariants: [{ id: 'default', label: 'Default' }],
      reasoningDefault: 'default',
      reasoningSupport: 'model-unsupported',
      showReasoningDefault: true,
      saveApprovalModePreference: () => {},
      saveReasoningPreference: () => {},
      saveShowReasoningPreference: () => {},
    },
    sendMessage: noop,
    approveToolCall: () => {},
    answerQuestion: () => {},
    compact: noop,
    stop: () => {},
    flushSave: noop,
    createNewSession: noop,
    loadSession: noop,
    listSessions: async () => [],
    selectModel: noop,
    isBusy: () => false,
    addEntry: () => {},
  } as unknown as AgentSessionClient;
}

/**
 * Renders a session holding one finished reasoning block and hands over a click
 * helper. The helper drives the real mouse bridge with raw SGR sequences, the
 * way a terminal delivers a press and a release, and returns the frame the app
 * repainted in response.
 */
async function withReasoningBlock(run: (click: (row: number, col: number) => Promise<string>) => Promise<void>): Promise<void> {
  const entries: SessionEntry[] = [{ kind: 'reasoning', text: 'alpha line\nbeta line\ngamma line', durationMs: 4_200 }];
  const sink = new Sink();
  const raw = new PassThrough() as PassThrough & { isTTY: boolean; setRawMode: (enabled: boolean) => void };
  Object.defineProperty(raw, 'isTTY', { value: true });
  raw.setRawMode = () => {};
  // The bridge only engages when the process looks interactive; without this the
  // mouse handler is never wired and every click assertion reads an unchanged frame.
  const stdoutIsTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
  Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
  const mouseInput = createMouseInputBridge(raw);
  const selection = {
    get isDragging() {
      return false;
    },
    frame: () => {},
    repaint: () => null,
    press: () => {},
    drag: () => false,
    release: () => 'click' as const,
    clear: () => {},
    selection: () => null,
    text: () => '',
    setViewport: () => {},
  };
  const instance = render(
    createElement(
      SessionScreen as never,
      {
        controller: fakeClient(entries),
        mouseInput,
        selection,
        initialTheme: 'Dark',
        systemTheme: 'dark',
      } as never,
    ),
    {
      stdout: sink as unknown as NodeJS.WriteStream,
      stdin: mouseInput.stdin as unknown as NodeJS.ReadStream,
      exitOnCtrlC: false,
      patchConsole: false,
      interactive: true,
    },
  );
  await instance.waitUntilRenderFlush();
  const click = async (row: number, col: number): Promise<string> => {
    const mark = sink.text.length;
    raw.write(`\u001b[<0;${col};${row}M`);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await instance.waitUntilRenderFlush();
    raw.write(`\u001b[<0;${col};${row}m`);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await instance.waitUntilRenderFlush();
    return sink.since(mark);
  };
  try {
    await run(click);
  } finally {
    instance.unmount();
    mouseInput.close();
    if (stdoutIsTTY) Object.defineProperty(process.stdout, 'isTTY', stdoutIsTTY);
    else Object.defineProperty(process.stdout, 'isTTY', { value: undefined, configurable: true });
  }
}

// The fixture paints the header on row 4 and the body on rows 5-7, because the
// block is the only transcript entry and the view is anchored at the top.
const HEADER_ROW = 4;
const BODY_ROW = 6;

describe('reasoning block toggling', () => {
  it('folds the block when its body is clicked, not only its header', async () => {
    // The block is one unit. Listening only on the header row left a click on
    // the text doing nothing, so the block could not be closed from the place
    // the reader is actually pointing at.
    await withReasoningBlock(async (click) => {
      const folded = await click(BODY_ROW, 8);
      expect(folded).not.toContain('beta line');
      expect(folded).toContain('Thought');
    });
  }, 60_000);

  it('reopens the block when the folded header is clicked again', async () => {
    await withReasoningBlock(async (click) => {
      const folded = await click(BODY_ROW, 8);
      expect(folded).not.toContain('beta line');
      const reopened = await click(HEADER_ROW, 8);
      expect(reopened).toContain('beta line');
    });
  }, 60_000);
});
