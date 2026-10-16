import type { JSONValue } from 'ai';
import { MAX_TOOL_INPUT_CHARS, type ToolDefinition } from './registry.js';

type TeamSend = (input: { recipient: string; text: string; replyTo?: string }) => Promise<unknown>;
type TeamInbox = (limit: number, acknowledge?: string[]) => Promise<unknown>;
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
    maxInputChars: 512,
    description:
      'Read the direct messages your team sent to this ranite, oldest first. Group channel traffic is not returned here; read it when you choose to. A direct message is what woke this session, so read it, act on it, and acknowledge ids that are fully handled so they stop counting as unread.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Maximum messages to read; defaults to 20.' },
        acknowledge: {
          type: 'array',
          maxItems: 50,
          items: { type: 'string' },
          description: 'Ids of team direct messages that are fully handled.',
        },
      },
    },
    effect: { change: 'none', data: 'sensitive', network: 'used', reversible: 'full', outbound: 'model' },
    autoApprove: () => true,
    toModelOutput: (output) => ({ type: 'json', value: output as JSONValue }),
    execute: (input) => {
      const limit = input.limit ?? 20;
      if (!Number.isSafeInteger(limit) || Number(limit) < 1 || Number(limit) > 50)
        return Promise.resolve({ status: 'invalid', error: 'limit must be an integer between 1 and 50.' });
      const acknowledge = input.acknowledge ?? [];
      if (!Array.isArray(acknowledge) || acknowledge.length > 50 || !acknowledge.every((id) => typeof id === 'string'))
        return Promise.resolve({ status: 'invalid', error: 'acknowledge must be an array of up to 50 message ids.' });
      return inbox(Number(limit), acknowledge as string[]);
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
