import * as client from './client.js';
import { GROUP_RECIPIENT, makeMessageId } from './service.js';
import type { TeamStore } from './store.js';
import type { JoinTarget } from './tailnet.js';

export interface TeamMessage {
  seq: number;
  msgId: string;
  sender: string;
  recipient: string;
  body: string;
  createdAt: number;
  replyTo: string | null;
}

export interface SendResult {
  msgId: string;
  seq?: number;
  createdAt?: number;
  duplicate?: boolean;
}

export type TeamMemoryTopic = 'decisions' | 'shared';

export interface TeamMemoryEntry {
  seq: number;
  topic: TeamMemoryTopic;
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
}

export interface TeamStatusView {
  team: string;
  you: string;
  memberCount: number;
  groupCursor: number;
  groupLatestSeq: number;
  members: TeamMemberView[];
}

/** A member counts as online when it has polled within this window (poll is 1s). */
const PRESENCE_WINDOW_MS = 15_000;

/**
 * One way to talk to a team, whether this machine is the hub or a member.
 * The hub reads and writes its own store directly (no network to itself);
 * a member goes through the hub's HTTP surface with its ticket.
 */
export interface TeamChannel {
  readonly name: string;
  send(recipient: string, body: string, replyTo?: string): Promise<SendResult>;
  group(since: number): Promise<{ latestSeq: number; messages: TeamMessage[] }>;
  groupCursor(): number;
  setGroupCursor(seq: number): Promise<void>;
  /** Read new group messages after this member's cursor, advancing it. */
  groupRead(limit: number): Promise<{ messages: TeamMessage[]; cursor: number; latestSeq: number }>;
  /** Team roster with presence and last activity. */
  status(): Promise<TeamStatusView>;
  inbox(): Promise<{ count: number; messages: TeamMessage[] }>;
  ack(msgIds: readonly string[]): Promise<{ acknowledged: number; remaining: number }>;
  memory(since: number): Promise<{ latestSeq: number; entries: TeamMemoryEntry[] }>;
  remember(topic: TeamMemoryTopic, body: string): Promise<{ seq: number }>;
}

/** The hub's own view: straight to the store, same clock and same sequence as everyone. */
export function localChannel(store: TeamStore, memberName: string): TeamChannel {
  return {
    name: memberName,
    async send(recipient, body, replyTo) {
      const msgId = makeMessageId();
      const stored = store.postMessage({
        msgId,
        sender: memberName,
        recipient: recipient === 'group' ? GROUP_RECIPIENT : recipient,
        body,
        createdAt: Date.now(),
        replyTo: replyTo ?? null,
      });
      return { msgId: stored.msgId, seq: stored.seq, createdAt: stored.createdAt };
    },
    async group(since) {
      return { latestSeq: store.groupLatestSeq(), messages: store.groupMessages(since, 200) };
    },
    groupCursor() {
      return store.getGroupCursor(memberName);
    },
    async setGroupCursor(seq) {
      store.setGroupCursor(memberName, seq);
    },
    async groupRead(limit) {
      const cursor = store.getGroupCursor(memberName);
      const messages = store.groupMessages(cursor, limit);
      if (messages.length > 0) store.setGroupCursor(memberName, messages.at(-1)!.seq);
      return { messages, cursor: store.getGroupCursor(memberName), latestSeq: store.groupLatestSeq() };
    },
    async status() {
      return {
        team: store.getMeta('team_name') ?? 'team',
        you: memberName,
        memberCount: store.listMembers().length,
        groupCursor: store.getGroupCursor(memberName),
        groupLatestSeq: store.groupLatestSeq(),
        members: store.memberSummaries(Date.now(), PRESENCE_WINDOW_MS),
      };
    },
    async inbox() {
      return { count: store.unreadDmCount(memberName), messages: store.unreadDms(memberName, 200) };
    },
    async ack(msgIds) {
      const acknowledged = store.ackDms(memberName, msgIds, Date.now());
      return { acknowledged, remaining: store.unreadDmCount(memberName) };
    },
    async memory(since) {
      return { latestSeq: store.memoryLatestSeq(), entries: store.memoryEntries(since, 500) };
    },
    async remember(topic, body) {
      const seq = store.appendMemory({ topic, author: memberName, body, createdAt: Date.now() });
      return { seq };
    },
  };
}

/** A member's view: over the tailnet to the hub, authenticated by the stored ticket. */
export function remoteChannel(target: JoinTarget, ticket: string, memberName: string, groupCursorStart = 0): TeamChannel {
  let cursor = groupCursorStart;
  return {
    name: memberName,
    send(recipient, body, replyTo) {
      return client.postMessage(target, ticket, { recipient, body, ...(replyTo ? { replyTo } : {}) });
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
        })),
      };
    },
    inbox() {
      return client.fetchInbox(target, ticket);
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
