import { Writable } from 'node:stream';
import { createElement, type ReactNode } from 'react';
import { Box, render } from 'ink';
import { describe, expect, it } from 'vitest';
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

async function renderLines(node: ReactNode): Promise<string[]> {
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
  const lines = sink.text
    .replace(ANSI, '')
    .split('\n')
    .map((line) => line.trimEnd());
  // Ink terminates the frame with one newline; it is not a content row.
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

function reasoningEntry(count = 60): SessionEntry {
  return {
    kind: 'reasoning',
    text: Array.from({ length: count }, (_, index) => `reasoning line ${index}`).join('\n'),
  };
}

function entryElement(entry: SessionEntry, rowWindow?: { top: number; bottom: number }) {
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
    mouseSupported: true,
    tokens,
    ...(rowWindow ? { rowWindow } : {}),
  });
}

function frame(node: ReactNode) {
  return createElement(Box, { width: WIDTH, flexDirection: 'column' }, node);
}

describe('visible row window', () => {
  it('keeps the entry height and shows the same rows the full entry would show', async () => {
    const entry = reasoningEntry();
    const full = await renderLines(frame(entryElement(entry)));

    for (const [top, bottom] of [
      [4, 16],
      [20, 32],
      [48, 60],
    ] as const) {
      const windowed = await renderLines(frame(entryElement(entry, { top, bottom })));
      // Geometry is unchanged: the skipped rows are spacers of the same height.
      expect(windowed.length).toBe(full.length);
      // The rows on screen are the same text, starting at the requested row.
      const firstContent = windowed.findIndex((line) => line !== '');
      expect(firstContent).toBe(top);
      expect(windowed.slice(top, bottom)).toEqual(full.slice(top, bottom));
    }
  });
});
