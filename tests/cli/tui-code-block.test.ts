import { Writable } from 'node:stream';
import { createElement, type ReactNode } from 'react';
import { render } from 'ink';
import { describe, expect, it } from 'vitest';
import { FrameSelectionTracker } from '../../src/cli/frame-selection.js';
import { TranscriptEntry } from '../../src/cli/terminal-session.js';
import { uiTokens } from '../../src/cli/theme.js';
import type { SessionEntry } from '../../src/session-store.js';

const WIDTH = 40;
const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]/g;
const tokens = uiTokens('Dark', 'dark');

class Sink extends Writable {
  text = '';
  override _write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.text += String(chunk);
    callback();
  }
}

async function renderFrame(node: ReactNode): Promise<string> {
  const sink = new Sink();
  const stdin = new Writable() as unknown as NodeJS.ReadStream;
  Object.assign(stdin, { isTTY: false, setRawMode() {} });
  const instance = render(node, {
    stdout: sink as unknown as NodeJS.WriteStream,
    stdin,
    exitOnCtrlC: false,
    patchConsole: false,
    interactive: false,
  });
  instance.unmount();
  return sink.text;
}

function frameLines(frame: string): string[] {
  const lines = frame
    .replace(ANSI, '')
    .split('\n')
    .map((line) => line.trimEnd());
  // Ink terminates the frame with one newline; it is not a content row.
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

function copyAll(frame: string): string {
  const tracker = new FrameSelectionTracker();
  tracker.frame(frame);
  tracker.press({ row: 0, col: 0 });
  tracker.drag({ row: 400, col: 400 });
  tracker.release();
  return tracker.text();
}

function assistantEntry(text: string): SessionEntry {
  return { kind: 'assistant', text };
}

function entryElement(entry: SessionEntry) {
  return createElement(TranscriptEntry, {
    entry,
    index: 0,
    width: WIDTH,
    streaming: false,
    expanded: false,
    expandedMessage: false,
    expandedNotice: false,
    hideReasoning: false,
    dimmed: false,
    setToolRef: () => {},
    tokens,
  });
}

describe('code block rendering', () => {
  const text = ['Before the block.', '', '```', 'status: "truncated"', 'spilledTo: path', '```', '', 'After the block.'].join('\n');

  it('draws no left bar, so a terminal-level selection copies the code cleanly', async () => {
    const frame = await renderFrame(entryElement(assistantEntry(text)));
    // Any glyph before the code would be picked up by the terminal's own
    // selection, which does not know about the in-app decoration marker.
    expect(frameLines(frame).filter((line) => line.includes('│'))).toEqual([]);
  });

  it('keeps one blank line between the code block and the surrounding text', async () => {
    const lines = frameLines(await renderFrame(entryElement(assistantEntry(text))));
    const first = lines.findIndex((line) => line.includes('status: "truncated"'));
    const last = lines.findIndex((line) => line.includes('spilledTo: path'));
    const before = lines.findIndex((line) => line.includes('Before the block.'));
    expect(first).toBeGreaterThan(before);
    expect(last).toBeGreaterThan(first);
    // Exactly one empty row on each side of the block.
    expect(lines[last + 1]).toBe('');
    expect(lines[last + 2]).toContain('After the block.');
    expect(lines[first - 1]).toBe('');
    expect(lines[first - 2]).toContain('Before the block.');
  });

  it('copies the code lines exactly through the in-app path', async () => {
    const frame = await renderFrame(entryElement(assistantEntry(text)));
    const copied = copyAll(frame)
      .trimEnd()
      .split('\n')
      .map((line) => line.trimEnd());
    expect(copied).toContain('status: "truncated"');
    expect(copied).toContain('spilledTo: path');
    expect(copied.some((line) => line.includes('│'))).toBe(false);
  });
});
