import { Writable } from 'node:stream';
import { createElement, type ReactNode } from 'react';
import { render } from 'ink';
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
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

function reasoningEntry(durationMs?: number): SessionEntry {
  return { kind: 'reasoning', text: 'first thought line\nsecond thought line', ...(durationMs === undefined ? {} : { durationMs }) };
}

function element(entry: SessionEntry, options: { hideReasoning?: boolean; reasoningToggled?: boolean } = {}) {
  return createElement(TranscriptEntry, {
    entry,
    index: 0,
    width: WIDTH,
    streaming: false,
    expanded: false,
    expandedMessage: false,
    expandedNotice: false,
    reasoningToggled: options.reasoningToggled ?? false,
    hideReasoning: options.hideReasoning ?? false,
    dimmed: false,
    setToolRef: () => {},
    mouseSupported: true,
    tokens,
  });
}

describe('reasoning block', () => {
  it('labels a finished block with the time the model actually spent thinking', async () => {
    const lines = await renderLines(element(reasoningEntry(13_240)));
    expect(lines[0]).toContain('Thought for 13.2s');
    expect(lines.join('\n')).toContain('first thought line');
  });

  it('shows a bare label while the block is still streaming', async () => {
    const lines = await renderLines(element(reasoningEntry()));
    expect(lines[0]).toContain('Thought');
    expect(lines[0]).not.toContain('for');
  });

  it('keeps the header when thinking is hidden, so the block can be reopened', async () => {
    const lines = await renderLines(element(reasoningEntry(4_500), { hideReasoning: true }));
    expect(lines[0]).toContain('Thought for 4.5s');
    // The body is gone, but the entry still occupies the header row.
    expect(lines.join('\n')).not.toContain('first thought line');
    expect(lines.length).toBeGreaterThan(0);
  });

  it('opens one hidden block when it was toggled by hand', async () => {
    const lines = await renderLines(element(reasoningEntry(4_500), { hideReasoning: true, reasoningToggled: true }));
    expect(lines[0]).toContain('Thought for 4.5s');
    expect(lines.join('\n')).toContain('first thought line');
  });

  it('folds a visible block when it was toggled by hand', async () => {
    // The toggle has to work in both directions: with thinking on, a click on the
    // block closes it, and the header stays so it can be opened again.
    const lines = await renderLines(element(reasoningEntry(4_500), { reasoningToggled: true }));
    expect(lines[0]).toContain('Thought for 4.5s');
    expect(lines.join('\n')).not.toContain('first thought line');
  });

  it('formats minutes once a block runs past a minute', async () => {
    const lines = await renderLines(element(reasoningEntry(95_000)));
    expect(lines[0]).toContain('Thought for 1m 35s');
  });
});
