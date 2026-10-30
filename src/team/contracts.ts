import type { PeerCapabilities, PeerProfile } from './coordination.js';

export const TEAM_PRESENCE_WINDOW_MS = 15_000;
export const TEAM_CAPABILITY_MAX_AGE_MS = 45_000;
export const TEAM_CAPABILITY_RENEW_MS = 20_000;
export const MAX_TEAM_MESSAGE_ID_CHARS = 256;
export const TEAM_PROTOCOL_VERSION = 'openbutler-team/2';

/** Wire and persistence DTOs. Adapters preserve these fields instead of redefining them. */
export interface TeamMessage {
  seq: number;
  msgId: string;
  sender: string;
  recipient: string;
  kind: string;
  body: string;
  fileId: string | null;
  createdAt: number;
  replyTo: string | null;
}

export interface TeamMemoryEntry {
  seq: number;
  topic: 'decisions' | 'shared';
  author: string;
  body: string;
  createdAt: number;
}

export interface TeamMemberView {
  name: string;
  role: string;
  online: boolean;
  lastSeen: number;
  lastMessageAt: number | null;
  lastMessageTo: string | null;
  lastMemoryAt: number | null;
  profile?: PeerProfile | null;
  capabilities?: PeerCapabilities | null;
  activeWorkCount?: number;
}

/** A transport outcome retains whether retrying the same operation is safe/necessary. */
export class TeamTransportError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'TeamTransportError';
  }
}
