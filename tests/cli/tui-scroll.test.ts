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
const WHEEL_UP = '\u001b[<64;10;10M';

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
      showReasoningDefault: false,
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

function topRow(frame: string): number {
  const match = /notice row (\d+)/.exec(frame);
  return match ? Number(match[1]) : -1;
}

/**
 * Sends raw SGR wheel sequences through the real mouse bridge, the way a
 * terminal delivers them: `chunks` writes, each carrying `perChunk` notches.
 */
async function wheelDistance(chunks: number, perChunk: number): Promise<number> {
  const entries: SessionEntry[] = Array.from({ length: 400 }, (_, index) => ({ kind: 'notice' as const, text: `notice row ${index}` }));
  const sink = new Sink();
  const raw = new PassThrough() as PassThrough & { isTTY: boolean; setRawMode: (enabled: boolean) => void };
  Object.defineProperty(raw, 'isTTY', { value: true });
  raw.setRawMode = () => {};
  // The bridge only engages when the process looks interactive; without this
  // the wheel handler is never wired and every scroll assertion compares two
  // unchanged frames.
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
  let lastFrame = '';
  for (let chunk = 0; chunk < chunks; chunk++) {
    const mark = sink.text.length;
    raw.write(WHEEL_UP.repeat(perChunk));
    await new Promise((resolve) => setTimeout(resolve, 5));
    await instance.waitUntilRenderFlush();
    lastFrame = sink.since(mark);
  }
  const top = topRow(lastFrame);
  instance.unmount();
  mouseInput.close();
  if (stdoutIsTTY) Object.defineProperty(process.stdout, 'isTTY', stdoutIsTTY);
  else Object.defineProperty(process.stdout, 'isTTY', { value: undefined, configurable: true });
  return top;
}

describe('mouse wheel input', () => {
  it('applies every notch in a batched terminal chunk', async () => {
    // One notch per chunk is the reference: the terminal sends each notch alone.
    const paced = await wheelDistance(5, 1);
    // Five notches in a single chunk is a trackpad-friendly terminal burst.
    const batched = await wheelDistance(1, 5);
    expect(batched).toBe(paced);
  }, 60_000);

  it('keeps moving on the notches after the first one', async () => {
    // The scroll callback is rebuilt only when the content height changes, so a
    // captured offset freezes: the first notch moves, every later notch
    // recomputes the same target and the view stops.
    const first = await wheelDistance(1, 1);
    const second = await wheelDistance(2, 1);
    const third = await wheelDistance(3, 1);
    expect(second).toBeLessThan(first);
    expect(third).toBeLessThan(second);
  }, 60_000);
});
