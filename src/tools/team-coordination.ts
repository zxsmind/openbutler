import { WORK_ACTIONS } from '../team/coordination.js';
import type { JSONValue } from 'ai';
import type { ToolDefinition } from './registry.js';

type PeerOperation = (input: Record<string, unknown>) => Promise<unknown>;

export function createTeamProfileTool(execute: PeerOperation): ToolDefinition {
  return {
    providerId: 'host',
    name: 'team_profile',
    maxInputChars: 6000,
    description:
      "Read a member's single team identity profile or update your own. Use read first; update replaces your description and requires its expectedRevision (0 if none). Describe your experience, working style, strengths, limitations, and useful collaboration context in natural language. Update when evidence changes how peers should understand you, not after every task. This is a self-description, not verified expertise or permission. Current MCP tools come separately from the host capability report in team_status; do not duplicate that inventory or include private owner information. There is no second local identity profile. An identical retry with the same revision and description is safe.",
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['read', 'update'] },
        member: { type: 'string', description: 'Read this member; omitted means yourself. Updates affect only yourself.' },
        description: { type: 'string', maxLength: 4000, description: 'Complete new description for update.' },
        expectedRevision: { type: 'integer', minimum: 0, description: 'Revision you read, required for update.' },
      },
      required: ['action'],
    },
    effect: { change: 'modify', data: 'sensitive', network: 'used', reversible: 'compensating', outbound: 'model-and-tool-server' },
    autoApprove: () => true,
    toModelOutput: (output) => ({ type: 'json', value: output as JSONValue }),
    execute,
  };
}

export function createTeamWorkTool(execute: PeerOperation): ToolDefinition {
  return {
    providerId: 'host',
    name: 'team_work',
    maxInputChars: 10000,
    description:
      'Track a bounded agreement between team peers. Use team_send for a plain question or request that needs no tracking; use team_work when you need a durable record of who owns a piece of work and where it stands. Propose with a unique id, a peer, and terms (outcome, scope, constraints, expected evidence); reuse the same id and terms after an ambiguous network result. The other participant accepts, rejects, or counters pending terms. Counter requires full replacement terms and a reason; it is not acceptance. Only the assignee starts accepted work, blocks active work, resumes blocked work, or reports complete/fail. Only the requester cancels. Either party may add a note without changing terms. Every change after propose requires expectedRevision and a meaningful note. complete needs the result and verification evidence in the note. Changes notify the other party atomically; read the record before acting on a notification. list defaults to your open agreements; read retrieves one by id. Reading a message never accepts or completes work. An agreement never grants owner authorization or remote access.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'read', ...WORK_ACTIONS],
        },
        id: {
          type: 'string',
          maxLength: 128,
          description: 'Stable unique work identifier, letters/digits/dashes/underscores. Required except for list.',
        },
        peer: { type: 'string', description: 'Proposed assignee; required for propose.' },
        terms: {
          type: 'string',
          maxLength: 4000,
          description:
            'Complete proposed or replacement terms; required for propose and counter. The other party must explicitly accept replacement terms.',
        },
        expectedRevision: { type: 'integer', minimum: 1, description: 'Revision read before a change, except propose.' },
        note: {
          type: 'string',
          maxLength: 4000,
          description: 'Reason, question, evidence, or full replacement terms for counter; required for changes after propose.',
        },
        includeClosed: { type: 'boolean', description: 'For list, include terminal agreements; default false.' },
        limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Maximum records for list; default 20.' },
        offset: {
          type: 'integer',
          minimum: 0,
          maximum: 10000,
          description: 'Skip this many records when paging list; default 0. Continue while a full page is returned.',
        },
      },
      required: ['action'],
    },
    effect: { change: 'modify', data: 'sensitive', network: 'used', reversible: 'compensating', outbound: 'model-and-tool-server' },
    autoApprove: () => true,
    toModelOutput: (output) => ({ type: 'json', value: output as JSONValue }),
    execute,
  };
}
