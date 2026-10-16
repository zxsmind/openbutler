import type { JSONValue } from 'ai';
import { MAX_TOOL_INPUT_CHARS, type ToolDefinition } from './registry.js';

type TeamSend = (input: { recipient: string; text: string; replyTo?: string }) => Promise<unknown>;
type TeamInbox = (limit: number) => Promise<unknown>;
type TeamGroup = (limit: number) => Promise<unknown>;
type TeamStatus = () => Promise<unknown>;
type TeamHistory = (query: { scope: 'group' | 'dm'; peer?: string; before?: number; limit?: number }) => Promise<unknown>;
type TeamRemember = (input: { topic: 'decisions' | 'shared'; text: string }) => Promise<unknown>;

/**
 * The team surface for the agent: post to the shared group or direct-message a
 * peer, and read the direct messages addressed to this ranite. Group traffic is
 * ambient (read when convenient); a direct message is what wakes this session.
 */
export function createTeamSendTool(send: TeamSend): ToolDefinition {
  return {
    providerId: 'host',
    name: 'team_send',
    maxInputChars: MAX_TOOL_INPUT_CHARS,
    description:
      'Send a message to your team over the tailnet. Address one member with recipient (their team name) for a direct message, or omit recipient (or use "group") to post to the shared group channel. A direct message wakes the recipient; a group post does not. Use this to coordinate work, hand off a task, ask a peer a question, or share a decision. Include replyTo with a message id when answering a direct message.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        recipient: {
          type: 'string',
          description: 'A team member name for a direct message, or "group" (the default) for the shared channel.',
        },
        text: { type: 'string', maxLength: 8000, description: 'Message text.' },
        replyTo: { type: 'string', description: 'Id of the team message this answers, when replying.' },
      },
      required: ['text'],
    },
    effect: { change: 'none', data: 'sensitive', network: 'used', reversible: 'none', outbound: 'model-and-tool-server' },
    autoApprove: () => true,
    execute: (input) => {
      const text = typeof input.text === 'string' ? input.text : '';
      if (!text.trim()) return Promise.resolve({ status: 'invalid', error: 'text is required.' });
      const recipient = typeof input.recipient === 'string' && input.recipient.trim() ? input.recipient.trim() : 'group';
      const replyTo = typeof input.replyTo === 'string' && input.replyTo.trim() ? input.replyTo.trim() : undefined;
      return send({ recipient, text, ...(replyTo ? { replyTo } : {}) });
    },
  };
}

export function createTeamInboxTool(inbox: TeamInbox): ToolDefinition {
  return {
    providerId: 'host',
    name: 'team_inbox',
    maxInputChars: 128,
    description:
      'Read the direct messages your team sent to this ranite, oldest first. A direct message is what woke this session, so read it and act on it. Reading consumes the messages: they are marked handled in the same step, so a message never returns on a later wake. When you answer a message with team_send, include its id in replyTo and it is acknowledged for you.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Maximum messages to read; defaults to 20.' },
      },
    },
    effect: { change: 'none', data: 'sensitive', network: 'used', reversible: 'full', outbound: 'model' },
    autoApprove: () => true,
    toModelOutput: (output) => ({ type: 'json', value: output as JSONValue }),
    execute: (input) => {
      const limit = input.limit ?? 20;
      if (!Number.isSafeInteger(limit) || Number(limit) < 1 || Number(limit) > 50)
        return Promise.resolve({ status: 'invalid', error: 'limit must be an integer between 1 and 50.' });
      return inbox(Number(limit));
    },
  };
}

/**
 * The shared group channel: read the messages the team posted since this
 * ranite last looked. Group traffic is ambient and never wakes a session, so
 * this is how a ranite catches up on the group on its own terms.
 */
export function createTeamGroupTool(group: TeamGroup): ToolDefinition {
  return {
    providerId: 'host',
    name: 'team_group',
    maxInputChars: 128,
    description:
      'Read new messages from the shared team group channel, oldest first, advancing your read position. The group is ambient: posting to it never wakes anyone, so use this to catch up on group traffic. To send to the group, use team_send with recipient "group".',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Maximum messages to read; defaults to 50.' },
      },
    },
    effect: { change: 'none', data: 'sensitive', network: 'used', reversible: 'full', outbound: 'model' },
    autoApprove: () => true,
    toModelOutput: (output) => ({ type: 'json', value: output as JSONValue }),
    execute: (input) => {
      const limit = input.limit ?? 50;
      if (!Number.isSafeInteger(limit) || Number(limit) < 1 || Number(limit) > 100)
        return Promise.resolve({ status: 'invalid', error: 'limit must be an integer between 1 and 100.' });
      return group(Number(limit));
    },
  };
}

/**
 * The team roster: who is in the team, who is online right now, and what each
 * member last did (last message and its destination, last shared-memory write).
 */
export function createTeamStatusTool(status: TeamStatus): ToolDefinition {
  return {
    providerId: 'host',
    name: 'team_status',
    maxInputChars: 64,
    description:
      'Show the team roster: every member, whether they are online now, when they were last seen, and their last activity (last message sent and where, and their last shared-memory write). Use this to see who is around and what the team has been doing before coordinating.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
    effect: { change: 'none', data: 'sensitive', network: 'used', reversible: 'full', outbound: 'model' },
    autoApprove: () => true,
    toModelOutput: (output) => ({ type: 'json', value: output as JSONValue }),
    execute: () => status(),
  };
}

/**
 * Persistent history: page older group messages or a direct-message
 * conversation at any time. This is a read-only view of the hub's log; it never
 * changes what is unread, so a ranite can look back without consuming anything.
 */
export function createTeamHistoryTool(history: TeamHistory): ToolDefinition {
  return {
    providerId: 'host',
    name: 'team_history',
    maxInputChars: 256,
    description:
      'Read older messages from the shared group or a direct-message conversation, newest first. Use scope "group" for the shared channel, or scope "dm" with peer set to a member name for your conversation with that member. Pass before as a message id sequence to page further back. This is a read-only look at the persistent log: it never marks anything read, so use team_inbox or team_group to catch up on new messages.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        scope: { type: 'string', enum: ['group', 'dm'], description: 'Read the shared group, or a direct-message conversation.' },
        peer: { type: 'string', description: 'The member to read a conversation with (required for scope "dm").' },
        before: { type: 'integer', minimum: 1, description: 'Page older messages before this message sequence number.' },
        limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Maximum messages to read; defaults to 50.' },
      },
      required: ['scope'],
    },
    effect: { change: 'none', data: 'sensitive', network: 'used', reversible: 'full', outbound: 'model' },
    autoApprove: () => true,
    toModelOutput: (output) => ({ type: 'json', value: output as JSONValue }),
    execute: (input) => {
      const scope = input.scope;
      if (scope !== 'group' && scope !== 'dm') return Promise.resolve({ status: 'invalid', error: 'scope must be "group" or "dm".' });
      const peer = typeof input.peer === 'string' && input.peer.trim() ? input.peer.trim() : undefined;
      if (scope === 'dm' && !peer) return Promise.resolve({ status: 'invalid', error: 'scope "dm" needs a peer member name.' });
      const before = typeof input.before === 'number' ? input.before : undefined;
      const limit = typeof input.limit === 'number' ? input.limit : undefined;
      return history({ scope, ...(peer ? { peer } : {}), ...(before ? { before } : {}), ...(limit ? { limit } : {}) });
    },
  };
}

/**
 * Shared team memory: durable decisions and facts every member reads. Writes
 * are signed with the author and never deleted; a changed decision gets a new
 * entry. This is the team's own memory, separate from the owner's memory.
 */
export function createTeamRememberTool(remember: TeamRemember): ToolDefinition {
  return {
    providerId: 'host',
    name: 'team_remember',
    maxInputChars: MAX_TOOL_INPUT_CHARS,
    description:
      'Record a durable entry in shared team memory, which every member reads and searches. Use topic "decisions" for agreements the team settled (who proposed it, what was decided) and "shared" for durable facts the whole team should know. One fact per call; the entry is signed with your name and the hub time, and nothing is ever deleted. Do not store secrets, credentials, or anything the owner would not want the team to see.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        topic: { type: 'string', enum: ['decisions', 'shared'], description: 'Which shared note to append to.' },
        text: { type: 'string', maxLength: 8000, description: 'One durable fact or decision, stated plainly.' },
      },
      required: ['topic', 'text'],
    },
    effect: { change: 'none', data: 'sensitive', network: 'used', reversible: 'none', outbound: 'model-and-tool-server' },
    autoApprove: () => true,
    execute: (input) => {
      const topic = input.topic;
      if (topic !== 'decisions' && topic !== 'shared')
        return Promise.resolve({ status: 'invalid', error: 'topic must be "decisions" or "shared".' });
      const text = typeof input.text === 'string' ? input.text : '';
      if (!text.trim()) return Promise.resolve({ status: 'invalid', error: 'text is required.' });
      return remember({ topic, text });
    },
  };
}
