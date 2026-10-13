import { describe, expect, it } from 'vitest';
import { advanceEyes, createEyesState, isPlainAsciiFrame, renderEyesFrame } from '../../src/cli/ascii-eyes.js';

function cyclingRandom(): () => number {
  let n = 0;
  return () => {
    n += 1;
    return (n % 1000) / 1000;
  };
}

describe('ascii eyes', () => {
  it('renders a centered plain-ASCII frame at the requested width', () => {
    const state = createEyesState(() => 0.5);
    const frame = renderEyesFrame(state, 72);
    expect(frame.length).toBeGreaterThan(0);
    for (const line of frame) expect(line).toHaveLength(72);
    expect(isPlainAsciiFrame(frame)).toBe(true);
    expect(frame.join('')).toContain('@');
  });

  it('renders nothing when the terminal is too narrow', () => {
    const state = createEyesState(() => 0.5);
    expect(renderEyesFrame(state, 30)).toEqual([]);
  });

  it('is deterministic for a fixed random source', () => {
    const first = renderEyesFrame(
      createEyesState(() => 0.5),
      72,
    );
    const second = renderEyesFrame(
      createEyesState(() => 0.5),
      72,
    );
    expect(first).toEqual(second);
  });

  it('advances gaze and expression over time', () => {
    const state = createEyesState(cyclingRandom());
    const before = renderEyesFrame(state, 72).join('\n');
    advanceEyes(state, 12);
    const after = renderEyesFrame(state, 72).join('\n');
    expect(state.clock).toBe(12);
    expect(after).not.toBe(before);
  });
});
