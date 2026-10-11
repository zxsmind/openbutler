import { describe, expect, it } from 'vitest';
import { workerLimitError } from '../src/daemon-host.js';

describe('worker concurrency caps', () => {
  it('allows a spawn below every cap', () => {
    expect(workerLimitError({ parentDepth: 0, runningForParent: 7, runningTotal: 9 })).toBeNull();
    expect(workerLimitError({ parentDepth: 1, runningForParent: 1, runningTotal: 4 })).toBeNull();
  });

  it('refuses the ninth worker of a main session', () => {
    const error = workerLimitError({ parentDepth: 0, runningForParent: 8, runningTotal: 9 });
    expect(error).toContain('limit 8');
  });

  it('gives a worker parent a limit of two children', () => {
    const error = workerLimitError({ parentDepth: 1, runningForParent: 2, runningTotal: 4 });
    expect(error).toContain('limit 2');
  });

  it('refuses at ten running workers machine-wide even when the parent has room', () => {
    const error = workerLimitError({ parentDepth: 0, runningForParent: 0, runningTotal: 10 });
    expect(error).toContain('limit 10');
    expect(error).toContain('machine');
  });
});
