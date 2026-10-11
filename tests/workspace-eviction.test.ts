import { expect, it } from 'vitest';
import { selectIdleWorkspacesToEvict } from '../src/workspace-eviction.js';

const policy = { now: 1_000_000, minIdleMs: 60_000, idleTtlMs: 30 * 60_000, maxIdle: 3 };

it('keeps every workspace while none is idle or over the resident bound', () => {
  expect(
    selectIdleWorkspacesToEvict(
      [
        { key: 'a', lastActivityAt: policy.now },
        { key: 'b', lastActivityAt: policy.now - 120_000 },
      ],
      policy,
    ),
  ).toEqual([]);
});

it('never evicts a workspace inside the activity grace window', () => {
  const candidates = Array.from({ length: 6 }, (_, index) => ({
    key: `w${index}`,
    lastActivityAt: policy.now - 59_999,
  }));
  expect(selectIdleWorkspacesToEvict(candidates, policy)).toEqual([]);
});

it('evicts least recently used workspaces when more than maxIdle would stay resident', () => {
  const candidates = [
    { key: 'fresh', lastActivityAt: policy.now - 60_000 },
    { key: 'newer', lastActivityAt: policy.now - 90_000 },
    { key: 'older', lastActivityAt: policy.now - 120_000 },
    { key: 'oldest', lastActivityAt: policy.now - 180_000 },
  ];
  expect(selectIdleWorkspacesToEvict(candidates, policy)).toEqual(['oldest']);
});

it('evicts expired workspaces regardless of pressure', () => {
  const candidates = [
    { key: 'expired', lastActivityAt: policy.now - policy.idleTtlMs },
    { key: 'recent', lastActivityAt: policy.now - 90_000 },
  ];
  expect(selectIdleWorkspacesToEvict(candidates, policy)).toEqual(['expired']);
});

it('orders ties deterministically and combines expiry with overflow', () => {
  const candidates = [
    { key: 'b', lastActivityAt: policy.now - 200_000 },
    { key: 'a', lastActivityAt: policy.now - 200_000 },
    { key: 'c', lastActivityAt: policy.now - 100_000 },
    { key: 'd', lastActivityAt: policy.now - 60_000 },
    { key: 'e', lastActivityAt: policy.now - 61_000 },
    { key: 'expired', lastActivityAt: policy.now - policy.idleTtlMs - 1 },
  ];
  expect(selectIdleWorkspacesToEvict(candidates, { ...policy, maxIdle: 1 })).toEqual(['expired', 'a', 'b', 'c', 'e']);
});
