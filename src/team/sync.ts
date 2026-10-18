import { TEAM_CAPABILITY_RENEW_MS } from './contracts.js';
import { materializeTeamMemory } from './memory-mirror.js';
import { readAllTeamMemory, type TeamConnection } from './session.js';
import type { TeamMemoryEntry } from './contracts.js';
import type { PeerCapabilities } from './coordination.js';
import { todayLocalDate } from '../file-write-core.js';

/** Owns host replication state; stale responses cannot publish over a newer membership. */
export class TeamSync {
  private memoryRun: Promise<void> | null = null;
  private memoryKey = '';
  private memorySeq = 0;
  private entries: TeamMemoryEntry[] = [];
  private reportRun: Promise<void> | null = null;
  private reportSignature = '';
  private reportedAt = 0;

  constructor(
    private readonly connect: () => TeamConnection,
    private readonly mirror = materializeTeamMemory,
    private readonly now = Date.now,
  ) {}

  refreshMemory(afterWrite = false): Promise<void> {
    if (this.memoryRun) return afterWrite ? this.memoryRun.then(() => this.refreshMemory()) : this.memoryRun;
    this.memoryRun = this.readMemory().finally(() => {
      this.memoryRun = null;
    });
    return this.memoryRun;
  }

  private async readMemory(): Promise<void> {
    const connection = this.connect();
    try {
      const sameMembership = this.memoryKey === connection.key;
      const since = sameMembership ? this.memorySeq : 0;
      let snapshot = await readAllTeamMemory(connection.channel, since);
      const reset = snapshot.latestSeq < since;
      if (reset) snapshot = await readAllTeamMemory(connection.channel);
      if (!connection.isCurrent()) return;
      if (sameMembership && !reset && snapshot.latestSeq === this.memorySeq) return;
      const entries = sameMembership && !reset ? [...this.entries, ...snapshot.entries] : snapshot.entries;
      this.mirror(connection.teamId, entries, todayLocalDate());
      this.entries = entries;
      this.memorySeq = snapshot.latestSeq;
      this.memoryKey = connection.key;
    } finally {
      connection.close();
    }
  }

  publishCapabilities(report: Omit<PeerCapabilities, 'observedAt'>): Promise<void> {
    if (this.reportRun) return this.reportRun;
    this.reportRun = this.publish(report).finally(() => {
      this.reportRun = null;
    });
    return this.reportRun;
  }

  private async publish(report: Omit<PeerCapabilities, 'observedAt'>): Promise<void> {
    const connection = this.connect();
    try {
      const signature = JSON.stringify({ membership: connection.key, report });
      // Renew the observation before the roster's 45s freshness window expires.
      if (signature === this.reportSignature && this.now() - this.reportedAt < TEAM_CAPABILITY_RENEW_MS) return;
      await connection.channel.reportCapabilities(report);
      if (!connection.isCurrent()) return;
      this.reportSignature = signature;
      this.reportedAt = this.now();
    } finally {
      connection.close();
    }
  }
}
