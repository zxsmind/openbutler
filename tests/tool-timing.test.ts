import { describe, expect, it } from 'vitest';
import { formatToolClock, toolTiming, withToolTiming } from '../src/tools/registry.js';

describe('tool timing', () => {
  it('stamps a text result with the run time and its duration', () => {
    const started = Date.parse('2026-10-21T08:09:39Z');
    const stamped = withToolTiming('command output', started, started + 9210);
    expect(stamped).toBe(`command output\n(ran at ${formatToolClock(started)}, took 9.2s)`);
  });

  it('adds the stamp beside a structured result without changing its payload', () => {
    const started = Date.parse('2026-10-21T08:09:39Z');
    const original = { status: 'completed', stdout: 'ok' };
    const stamped = withToolTiming(original, started, started + 400) as Record<string, unknown>;
    // Same object, same payload, one extra field naming when the call ran.
    expect(stamped).toBe(original);
    expect(stamped).toMatchObject({ status: 'completed', stdout: 'ok' });
    expect(stamped.openbutlerTiming).toBe(`ran at ${formatToolClock(started)}, took 0.4s`);
    expect(toolTiming(stamped)).toBe(stamped.openbutlerTiming);
  });

  it('says nothing when a result carries no timing', () => {
    expect(toolTiming({ status: 'completed' })).toBeNull();
    expect(toolTiming('plain')).toBeNull();
    expect(toolTiming(null)).toBeNull();
    expect(withToolTiming(42, 0, 10)).toBe(42);
  });

  it('formats local wall time with the offset that belongs to it', () => {
    const at = Date.parse('2026-10-21T08:09:39Z');
    const clock = formatToolClock(at);
    expect(clock).toMatch(/^2026-10-21 \d{2}:\d{2}:\d{2} [+-]\d{2}:\d{2}$/);
    expect(Date.parse(clock.replace(' ', 'T').replace(' ', ''))).toBe(at);
  });
});
