import { describe, expect, it, vi } from 'vitest';
import { EmbeddingIdleLease, type EmbeddingLease } from '../src/memory-index.js';

function countingLease(): EmbeddingLease & { acquires: number; releases: number } {
  const lease = {
    acquires: 0,
    releases: 0,
    async acquire() {
      lease.acquires += 1;
    },
    async release() {
      lease.releases += 1;
    },
  };
  return lease;
}

describe('embedding idle lease', () => {
  it('releases the model once the idle window passes and reloads on the next search', async () => {
    const lease = countingLease();
    const idle = new EmbeddingIdleLease(lease, 10);
    await idle.acquire();
    idle.touch();
    expect(idle.isHeld).toBe(true);
    await vi.waitFor(() => expect(lease.releases).toBe(1), { timeout: 1_000, interval: 5 });
    expect(idle.isHeld).toBe(false);

    await idle.acquire();
    expect(lease.acquires).toBe(2);
    expect(idle.isHeld).toBe(true);
    await idle.release();
    expect(lease.releases).toBe(2);
  });

  it('keeps the model warm while searches keep arriving', async () => {
    const lease = countingLease();
    const idle = new EmbeddingIdleLease(lease, 40);
    await idle.acquire();
    for (let index = 0; index < 5; index++) {
      await new Promise((resolve) => setTimeout(resolve, 15));
      idle.touch();
    }
    expect(lease.releases).toBe(0);
    expect(idle.isHeld).toBe(true);
    await idle.release();
  });

  it('does not let an idle release land in the middle of an acquire', async () => {
    const lease = countingLease();
    let releaseFirst!: () => void;
    const blocked: EmbeddingLease = {
      acquire: () =>
        new Promise<void>((resolve) => {
          releaseFirst = () => {
            lease.acquires += 1;
            resolve();
          };
        }),
      release: async () => {
        lease.releases += 1;
      },
    };
    const idle = new EmbeddingIdleLease(blocked, 5);
    const acquiring = idle.acquire();
    await new Promise((resolve) => setTimeout(resolve, 20));
    // The idle clock has expired by wall time, but the acquire still owns it.
    expect(lease.releases).toBe(0);
    releaseFirst();
    await acquiring;
    expect(idle.isHeld).toBe(true);
    await idle.release();
  });
});
