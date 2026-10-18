import { TEAM_PRESENCE_WINDOW_MS } from './contracts.js';
import * as client from './client.js';
import type { TeamMessage, TeamMemoryEntry, TeamMemberView } from './contracts.js';
export type { TeamMessage, TeamMemoryEntry, TeamMemberView } from './contracts.js';
import { makeFileId } from './service.js';
import { TeamOperations } from './operations.js';
import { statSync } from 'node:fs';
import { createReadStream } from 'node:fs';
import { basename } from 'node:path';
import { fileExists, filePath, hashFile, storeFileBytes, writeVerifiedFile } from './files.js';
import type { TeamStore } from './store.js';
import type { JoinTarget } from './tailnet.js';
import { TeamCoordination, type PeerCapabilities } from './coordination.js';

export interface SendResult {
  msgId: string;
  seq?: number;
  createdAt?: number;
  duplicate?: boolean;
}

export type TeamMemoryTopic = 'decisions' | 'shared';

export interface TeamStatusView {
  team: string;
  you: string;
  memberCount: number;
  groupCursor: number;
  groupLatestSeq: number;
  members: TeamMemberView[];
}

/** One immutable membership and transport selection for the entire operation. */
export interface TeamConnection {
  readonly key: string;
  readonly teamId: string;
  readonly channel: TeamChannel;
  isCurrent(): boolean;
  close(): void;
}

/** A member counts as online when it has polled within this window (poll is 1s). */

/**
 * Reads the whole shared-memory log, paging until caught up. A single call is
 * capped, so a team with more than one page of entries must loop or the mirror
 * silently loses the tail; this is the one place that loops.
 */
export async function readAllTeamMemory(channel: TeamChannel, sinceSeq = 0): Promise<{ entries: TeamMemoryEntry[]; latestSeq: number }> {
  const entries: TeamMemoryEntry[] = [];
  let since = sinceSeq;
  let latestSeq = 0;
  for (;;) {
    const page = await channel.memory(since);
    latestSeq = page.latestSeq;
    entries.push(...page.entries);
    const last = page.entries.at(-1);
    if (!last || last.seq >= page.latestSeq) return { entries, latestSeq };
    since = last.seq;
  }
}

/**
 * One way to talk to a team, whether this machine is the hub or a member.
 * The hub reads and writes its own store directly (no network to itself);
 * a member goes through the hub's HTTP surface with its ticket.
 */
export interface TeamChannel {
  readonly name: string;
  profile(input: Record<string, unknown>): Promise<unknown>;
  work(input: Record<string, unknown>): Promise<unknown>;
  reportCapabilities(input: Omit<PeerCapabilities, 'observedAt'>): Promise<void>;
  send(recipient: string, body: string, replyTo?: string, msgId?: string): Promise<SendResult>;
  group(since: number): Promise<{ latestSeq: number; messages: TeamMessage[] }>;
  groupCursor(): number;
  setGroupCursor(seq: number): Promise<void>;
  /** Read without advancing; setGroupCursor acknowledges the handled page explicitly. */
  groupRead(limit: number): Promise<{ messages: TeamMessage[]; cursor: number; latestSeq: number }>;
  /** Page older messages from the group or a DM conversation, newest first. */
  history(query: { scope: 'group' | 'dm'; peer?: string; before?: number; limit?: number }): Promise<{ messages: TeamMessage[] }>;
  /** Send a local file to a member or the group. No approval; receiving needs it. */
  sendFile(input: {
    recipient: string;
    path: string;
    transfer?: { id: string; name: string; size: number; sha256: string };
  }): Promise<{ id: string; seq: number }>;
  /** Download a shared file to a local path, verifying its hash. */
  receiveFile(input: { id: string; to: string }): Promise<{ path: string; name: string; size: number }>;
  /** Files this member can receive (addressed to them or the group). */
  listFiles(): Promise<client.TeamFileInfo[]>;
  /** Team roster with presence and last activity. */
  status(): Promise<TeamStatusView>;
  inbox(): Promise<{ count: number; messages: TeamMessage[] }>;
  /** Read pending DMs without acknowledging them. */
  readInbox(limit: number): Promise<{ count: number; messages: TeamMessage[]; remaining: number }>;
  ack(msgIds: readonly string[]): Promise<{ acknowledged: number; remaining: number }>;
  memory(since: number): Promise<{ latestSeq: number; entries: TeamMemoryEntry[] }>;
  remember(topic: TeamMemoryTopic, body: string): Promise<{ seq: number }>;
}

/** The hub's own view: straight through the same operation owner as the HTTP path. */
export function localChannel(store: TeamStore, memberName: string): TeamChannel {
  const operations = new TeamOperations(store);
  const coordination = new TeamCoordination(store);
  return {
    name: memberName,
    async profile(input) {
      return coordination.profile(memberName, input);
    },
    async work(input) {
      return coordination.work(memberName, input);
    },
    async reportCapabilities(input) {
      coordination.reportCapabilities(memberName, input);
    },
    async send(recipient, body, replyTo, msgId) {
      const result = operations.postMessage(memberName, {
        recipient,
        body,
        ...(replyTo ? { replyTo } : {}),
        ...(msgId ? { msgId } : {}),
      });
      if (result.duplicate) return { msgId: result.msgId, duplicate: true };
      return { msgId: result.message.msgId, seq: result.message.seq, createdAt: result.message.createdAt };
    },
    async group(since) {
      return { latestSeq: store.groupLatestSeq(), messages: store.groupMessages(since, 200) };
    },
    groupCursor() {
      return store.getGroupCursor(memberName);
    },
    async setGroupCursor(seq) {
      operations.acknowledgeGroup(memberName, seq);
    },
    async groupRead(limit) {
      return operations.readGroup(memberName, limit);
    },
    async history(query) {
      const before = query.before ?? 0;
      const limit = query.limit ?? 50;
      if (query.scope === 'group') return { messages: store.groupHistory(before, limit) };
      const canonical = query.peer ? store.canonicalMemberName(query.peer) : null;
      if (!canonical) throw new Error(`No member named "${query.peer ?? ''}" in this team.`);
      return { messages: store.dmHistory(memberName, canonical, before, limit) };
    },
    async sendFile(input) {
      const info = statSync(input.path);
      if (!info.isFile()) throw new Error(`${input.path} is not a file.`);
      const file = operations.prepareFile(memberName, {
        recipient: input.recipient,
        name: input.transfer?.name ?? basename(input.path),
        size: input.transfer?.size ?? info.size,
        sha256: input.transfer?.sha256 ?? (await hashFile(input.path)),
        fileId: input.transfer?.id ?? makeFileId(),
      });
      await storeFileBytes(createReadStream(input.path), file.id, file);
      const message = operations.registerFile(memberName, {
        recipient: file.recipient,
        name: file.name,
        size: file.size,
        sha256: file.sha256,
        fileId: file.id,
      });
      return { id: file.id, seq: message.seq };
    },
    async receiveFile(input) {
      const file = operations.fileForMember(memberName, input.id);
      if (!fileExists(file.id)) throw new Error(`The bytes for ${file.name} are no longer on the hub.`);
      await writeVerifiedFile(createReadStream(filePath(file.id)), input.to, file);
      return { path: input.to, name: file.name, size: file.size };
    },
    async listFiles() {
      return store.filesForMember(memberName);
    },
    async status() {
      return {
        team: store.getMeta('team_name') ?? 'team',
        you: memberName,
        memberCount: store.listMembers().length,
        groupCursor: store.getGroupCursor(memberName),
        groupLatestSeq: store.groupLatestSeq(),
        members: store.memberSummaries(Date.now(), TEAM_PRESENCE_WINDOW_MS),
      };
    },
    async inbox() {
      return { count: store.unreadDmCount(memberName), messages: store.unreadDms(memberName, 200) };
    },
    async readInbox(limit) {
      const messages = store.unreadDms(memberName, limit);
      return { count: messages.length, messages, remaining: Math.max(0, store.unreadDmCount(memberName) - messages.length) };
    },
    async ack(msgIds) {
      const acknowledged = store.ackDms(memberName, msgIds, Date.now());
      return { acknowledged, remaining: store.unreadDmCount(memberName) };
    },
    async memory(since) {
      return { latestSeq: store.memoryLatestSeq(), entries: store.memoryEntries(since, 500) };
    },
    async remember(topic, body) {
      const seq = operations.appendMemory(memberName, topic, body);
      return { seq };
    },
  };
}

/** A member's view: over the tailnet to the hub, authenticated by the stored ticket. */
export function remoteChannel(target: JoinTarget, ticket: string, memberName: string, groupCursorStart = 0): TeamChannel {
  let cursor = groupCursorStart;
  return {
    name: memberName,
    profile(input) {
      return client.peerOperation(target, ticket, 'profile', input);
    },
    work(input) {
      return client.peerOperation(target, ticket, 'work', input);
    },
    async reportCapabilities(input) {
      await client.peerOperation(target, ticket, 'capabilities', input);
    },
    send(recipient, body, replyTo, msgId) {
      return client.postMessage(target, ticket, { recipient, body, ...(replyTo ? { replyTo } : {}), ...(msgId ? { msgId } : {}) });
    },
    group(since) {
      return client.fetchGroup(target, ticket, since);
    },
    groupCursor() {
      return cursor;
    },
    async setGroupCursor(seq) {
      cursor = seq;
      await client.setGroupCursor(target, ticket, seq);
    },
    groupRead(limit) {
      return client.readGroup(target, ticket, limit);
    },
    history(query) {
      return client.fetchHistory(target, ticket, query);
    },
    async sendFile(input) {
      const info = statSync(input.path);
      if (!info.isFile()) throw new Error(`${input.path} is not a file.`);
      return client.uploadFile(target, ticket, {
        recipient: input.recipient,
        name: input.transfer?.name ?? basename(input.path),
        size: input.transfer?.size ?? info.size,
        sha256: input.transfer?.sha256 ?? (await hashFile(input.path)),
        id: input.transfer?.id ?? makeFileId(),
        source: createReadStream(input.path),
      });
    },
    async receiveFile(input) {
      const result = await client.downloadFile(target, ticket, input.id, input.to);
      return { path: input.to, name: result.name, size: result.size };
    },
    listFiles() {
      return client.listFiles(target, ticket);
    },
    async status() {
      const live = await client.fetchHubStatus(target, ticket);
      return {
        team: live.team,
        you: live.you,
        memberCount: live.memberCount ?? live.members.length,
        groupCursor: live.groupCursor ?? 0,
        groupLatestSeq: live.groupLatestSeq ?? 0,
        members: live.members.map((member) => ({
          name: member.name,
          role: member.role,
          online: member.online ?? false,
          lastSeen: member.lastSeen ?? 0,
          lastMessageAt: member.lastMessageAt ?? null,
          lastMessageTo: member.lastMessageTo ?? null,
          lastMemoryAt: member.lastMemoryAt ?? null,
          profile: member.profile ?? null,
          capabilities: member.capabilities ?? null,
          activeWorkCount: member.activeWorkCount ?? 0,
        })),
      };
    },
    inbox() {
      return client.fetchInbox(target, ticket);
    },
    readInbox(limit) {
      return client.readInbox(target, ticket, limit);
    },
    ack(msgIds) {
      return client.ackInbox(target, ticket, msgIds);
    },
    memory(since) {
      return client.fetchTeamMemory(target, ticket, since);
    },
    remember(topic, body) {
      return client.postTeamMemory(target, ticket, topic, body);
    },
  };
}
