import { Readable, Writable } from 'node:stream';
import { createElement, type ReactNode } from 'react';
import { render, Text } from 'ink';
import { describe, expect, it } from 'vitest';
import { FrameSelectionTracker, decorate } from '../../src/cli/frame-selection.js';

/**
 * Ink's text pipeline trims leading zero-width format characters, so a
 * decoration marker placed at the very start of a line is dropped before it
 * ever reaches the frame. These tests render through Ink for real, because the
 * unit tests operate on strings the renderer never actually produces.
 */
async function renderFrame(node: ReactNode): Promise<string> {
  const chunks: string[] = [];
  const stdout = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(chunk.toString());
      callback();
    },
  });
  Object.assign(stdout, { columns: 40 });
  const stdin = new Readable({ read() {} });
  Object.assign(stdin, { isTTY: false, setRawMode() {} });
  const instance = render(node, { stdout, stdin, exitOnCtrlC: false, patchConsole: false });
  const deadline = Date.now() + 4000;
  const latest = () => chunks.filter((chunk) => chunk.length > 0).at(-1) ?? '';
  while (Date.now() < deadline && !latest().includes('\u200c')) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  instance.unmount();
  return latest();
}

function copyAll(frame: string): string {
  const tracker = new FrameSelectionTracker();
  tracker.frame(frame);
  tracker.press({ row: 0, col: 0 });
  tracker.drag({ row: 200, col: 200 });
  tracker.release();
  return tracker.text();
}

describe('frame decoration through Ink', () => {
  it('keeps the marker in the frame and drops the chrome from a copy', async () => {
    const frame = await renderFrame(createElement(Text, null, decorate('│ '), 'hello'));
    expect(frame).toContain('\u200c');
    expect(copyAll(frame).trimEnd()).toBe('hello');
  });

  it('drops a per-line quote bar from the copy', async () => {
    const frame = await renderFrame(createElement(Text, null, decorate('│ '), 'first line\n', decorate('│ '), 'second line'));
    expect(copyAll(frame).trimEnd()).toBe('first line\nsecond line');
  });
});
