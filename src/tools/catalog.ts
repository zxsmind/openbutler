import type { MemoryIndex } from '../memory-index.js';
import { createBackgroundManagementTool } from './background.js';
import { createExecuteCommandTool } from './execute-command.js';
import { createEditTool } from './file-edit.js';
import { createReadTool } from './file-read.js';
import { createGlobTool, createGrepTool } from './file-search.js';
import { createWriteTool } from './file-write.js';
import { createMcpManagementTool, type McpConnectionManager } from './mcp.js';
import { createMemorySearchTool } from './memory-search.js';
import { createParentMessageTool } from './parent-message.js';
import { createQuestionTool } from './question.js';
import { createSessionListTool } from './session-list.js';
import { createSessionMessageTool } from './session-message.js';
import { createSessionReadTool } from './session-read.js';
import { createSessionSearchTool } from './session-search.js';
import { createSubagentPollTool } from './subagent-poll.js';
import { createSubagentStopTool } from './subagent-stop.js';
import { createSubagentTool, type SubagentRequest } from './subagent.js';
import type { ToolDefinition } from './registry.js';
import { createReadOwnerMessagesTool, createSendMessageToOwnerTool } from './owner-communication.js';
import { createTeamInboxTool, createTeamRememberTool, createTeamSendTool } from './team-communication.js';

export interface ToolCatalogueOptions {
  workspaceRoot: string;
  inputModalities: readonly string[];
  memoryIndex: MemoryIndex;
  mcp: McpConnectionManager;
  /** Rebuilds the registry after an MCP connection change. */
  onMcpConnectionsChanged: () => void;
  backgroundManage?: (input: Record<string, unknown>, workspaceRoot: string, senderSessionId: string | undefined) => Promise<unknown>;
  ownerMessageSend?: (input: Record<string, unknown>, workspaceRoot: string) => Promise<unknown>;
  ownerInboxRead?: (limit: number, acknowledge?: string[]) => Promise<unknown>;
  teamSend?: (input: { recipient: string; text: string; replyTo?: string }) => Promise<unknown>;
  teamInbox?: (limit: number, acknowledge?: string[]) => Promise<unknown>;
  teamRemember?: (input: { topic: 'decisions' | 'shared'; text: string }) => Promise<unknown>;
  sessionMessage?: (input: Record<string, unknown>, senderSessionId: string | undefined) => Promise<unknown> | unknown;
  subagent?: (request: SubagentRequest, senderSessionId: string | undefined, signal?: AbortSignal) => Promise<unknown> | unknown;
  parentMessage?: (input: { text: string }, senderSessionId: string | undefined) => Promise<unknown> | unknown;
  subagentPoll?: (input: { session: string }, senderSessionId: string | undefined) => Promise<unknown> | unknown;
  subagentStop?: (input: { session: string }, senderSessionId: string | undefined) => Promise<unknown> | unknown;
}

/**
 * The single place that decides which tools exist, in what order, and how the
 * native, memory, MCP, and background surfaces compose into one catalogue.
 * Definitions stay the mechanism; this module is the structure.
 *
 * Every session sees every tool, always. A missing host handler is not a
 * missing tool: the tool is still offered and answers `unavailable` with the
 * reason, so the model learns the boundary from one call instead of guessing
 * from an absent name. (Worker sandboxes are the only exception: `allowTools`
 * narrows what a worker is offered, and that narrowing is containment, not a
 * condition on sessions.)
 */
export function createToolCatalogue(options: ToolCatalogueOptions): ToolDefinition[] {
  const unavailable = (name: string) => async () => ({
    status: 'unavailable' as const,
    error: `${name} is not available in this session. Work without it and say so if it blocks the goal.`,
  });
  const definitions: ToolDefinition[] = [
    createExecuteCommandTool(options.workspaceRoot),
    createReadTool(options.inputModalities, options.workspaceRoot),
    createWriteTool(options.workspaceRoot, options.memoryIndex),
    createEditTool(options.workspaceRoot, options.memoryIndex),
    createGlobTool(options.workspaceRoot),
    createGrepTool(options.workspaceRoot),
    createQuestionTool(),
    createMemorySearchTool(options.memoryIndex),
    createSessionListTool(options.workspaceRoot),
    createSessionSearchTool(options.workspaceRoot),
    createSessionReadTool(),
    createSendMessageToOwnerTool(options.workspaceRoot, options.ownerMessageSend ?? unavailable('send_message_to_owner')),
    createReadOwnerMessagesTool(
      options.ownerInboxRead ??
        (async () => ({ status: 'unavailable' as const, error: 'read_owner_messages is not available in this session.' })),
    ),
    createSessionMessageTool(options.sessionMessage ?? (async () => ({ status: 'unavailable' as const }))),
    createTeamSendTool(options.teamSend ?? unavailable('team_send')),
    createTeamInboxTool(
      options.teamInbox ?? (async () => ({ status: 'unavailable' as const, error: 'team_inbox is not available in this session.' })),
    ),
    createTeamRememberTool(
      options.teamRemember ?? (async () => ({ status: 'unavailable' as const, error: 'team_remember is not available in this session.' })),
    ),
    createSubagentTool(options.subagent ?? (async () => ({ status: 'unavailable' as const }))),
    createParentMessageTool(options.parentMessage ?? (async () => ({ status: 'unavailable' as const }))),
    createSubagentPollTool(options.subagentPoll ?? (async () => ({ status: 'unavailable' as const }))),
    createSubagentStopTool(options.subagentStop ?? (async () => ({ status: 'unavailable' as const }))),
    createBackgroundManagementTool(
      options.workspaceRoot,
      options.backgroundManage ??
        (async () => ({ status: 'unavailable' as const, error: 'No background host is attached to this session.' })),
    ),
    createMcpManagementTool(options.mcp, options.onMcpConnectionsChanged),
  ];
  definitions.push(...options.mcp.tools);
  return definitions;
}
