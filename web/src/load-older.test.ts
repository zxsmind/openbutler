import { describe, expect, it } from 'vitest';
import { shouldLoadOlderFitted } from './load-older.js';

describe('shouldLoadOlderFitted', () => {
  it('loads without a gesture while the loaded slice still fits the viewport', () => {
    expect(shouldLoadOlderFitted(true, false, 800, 900)).toBe(true);
    expect(shouldLoadOlderFitted(true, false, 905, 900)).toBe(true);
  });

  it('leaves a scrollable slice to the top-edge scroll trigger', () => {
    expect(shouldLoadOlderFitted(true, false, 2000, 900)).toBe(false);
  });

  it('stays quiet when history is exhausted or a request is already in flight', () => {
    expect(shouldLoadOlderFitted(false, false, 800, 900)).toBe(false);
    expect(shouldLoadOlderFitted(true, true, 800, 900)).toBe(false);
  });
});
