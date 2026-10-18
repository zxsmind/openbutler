import { describe, expect, it, vi } from 'vitest';
import { TeamSync } from '../src/team/sync.js';
import type { TeamConnection, TeamChannel } from '../src/team/session.js';
import type { TeamMemoryEntry } from '../src/team/contracts.js';

function connection(channel: Partial<TeamChannel>, current = () => true): TeamConnection {
  return { key: 'A', teamId: 'A', channel: channel as TeamChannel, isCurrent: current, close: () => {} };
}
const entry = (seq: number): TeamMemoryEntry => ({ seq, topic: 'shared', body: `entry-${seq}`, author: 'Peer', createdAt: 1 });

describe('team replication ownership', () => {
  it('serializes memory reads, then fetches only the delta after a write', async () => {
    let release!: (value: { entries: TeamMemoryEntry[]; latestSeq: number }) => void;
    const gate = new Promise<{ entries: TeamMemoryEntry[]; latestSeq: number }>((resolve) => {
      release = resolve;
    });
    const memory = vi
      .fn()
      .mockReturnValueOnce(gate)
      .mockResolvedValue({ entries: [entry(2)], latestSeq: 2 });
    const mirror = vi.fn();
    const sync = new TeamSync(() => connection({ memory }), mirror);
    const first = sync.refreshMemory();
    const concurrent = sync.refreshMemory();
    const afterWrite = sync.refreshMemory(true);
    expect(memory).toHaveBeenCalledTimes(1);
    release({ entries: [entry(1)], latestSeq: 1 });
    await Promise.all([first, concurrent, afterWrite]);
    expect(memory.mock.calls.map((call) => call[0])).toEqual([0, 1]);
    expect(mirror.mock.calls.map((call) => call[1].map((row: TeamMemoryEntry) => row.seq))).toEqual([[1], [1, 2]]);
  });

  it('does not publish a response from a membership that has changed', async () => {
    let active = true;
    const memory = vi.fn(async () => {
      active = false;
      return { entries: [entry(1)], latestSeq: 1 };
    });
    const mirror = vi.fn();
    await new TeamSync(() => connection({ memory }, () => active), mirror).refreshMemory();
    expect(mirror).not.toHaveBeenCalled();
  });

  it('renews an unchanged capability observation before its freshness window expires', async () => {
    let now = 100_000;
    const reportCapabilities = vi.fn(async () => {});
    const sync = new TeamSync(
      () => connection({ reportCapabilities }),
      vi.fn(),
      () => now,
    );
    const report = { platform: 'linux', mcpTools: [], mcpServers: [], custodianBusy: false };
    await sync.publishCapabilities(report);
    now += 10_000;
    await sync.publishCapabilities(report);
    expect(reportCapabilities).toHaveBeenCalledTimes(1);
    now += 10_000;
    await sync.publishCapabilities(report);
    expect(reportCapabilities).toHaveBeenCalledTimes(2);
  });
});
