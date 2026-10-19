import type { InboxRequest } from '../inbox.js';
import type { ParentMessageInput } from '../worker-records.js';
import type { MemoryIndex } from '../memory-index.js';
import { createScheduleTool } from './schedule.js';
import { createExecuteCommandTool } from './execute-command.js';
import { createEditTool } from './file-edit.js';
import { createReadTool } from './file-read.js';
import { createGlobTool, createGrepTool } from './file-search.js';
import { createWriteTool } from './file-write.js';
import { createMcpManagementTool, type McpConnectionManager } from './mcp.js';
import { createMemorySearchTool } from './memory-search.js';
import { createMemoryWriteTool } from './memory-write.js';
import { createParentMessageTool } from './parent-message.js';
import { createQuestionTool } from './question.js';
import { createSessionListTool } from './session-list.js';
import { createSessionMessageTool } from './session-message.js';
import { createSessionReadTool } from './session-read.js';
import { createSessionSearchTool } from './session-search.js';
import { createInboxTool } from './inbox.js';
import { createSubagentStopTool } from './subagent-stop.js';
import { createSubagentTool, type SubagentRequest } from './subagent.js';
import type { ToolDefinition } from './registry.js';
import { createSendMessageToOwnerTool } from './owner-communication.js';
import { createTeamProfileTool, createTeamWorkTool } from './team-coordination.js';
import {
  createTeamFilesTool,
  createTeamGroupTool,
  createTeamHistoryTool,
  createTeamReceiveFileTool,
  createTeamRememberTool,
  createTeamSendFileTool,
  createTeamSendTool,
  createTeamDeliveryTool,
  createTeamStatusTool,
} from './team-communication.js';

export interface ToolCatalogueOptions {
  workspaceRoot: string;
  inputModalities: readonly string[];
  memoryIndex: MemoryIndex;
  mcp: McpConnectionManager;
  /** Rebuilds the registry after an MCP connection change. */
  onMcpConnectionsChanged: () => void;
  backgroundManage?: (input: Record<string, unknown>, workspaceRoot: string, senderSessionId: string | undefined) => Promise<unknown>;
  inbox?: (request: InboxRequest, sessionId: string | undefined) => Promise<unknown>;
  ownerMessageSend?: (input: Record<string, unknown>, workspaceRoot: string) => Promise<unknown>;
  teamDelivery?: (input: Record<string, unknown>) => Promise<unknown>;
  teamSend?: (input: { recipient: string; text: string; replyTo?: string }) => Promise<unknown>;
  teamGroup?: (limit: number, acknowledge?: number) => Promise<unknown>;
  teamHistory?: (query: { scope: 'group' | 'dm'; peer?: string; before?: number; limit?: number }) => Promise<unknown>;
  teamStatus?: () => Promise<unknown>;
  teamSendFile?: (input: { path: string; to: string }) => Promise<unknown>;
  teamReceiveFile?: (input: { id: string; to?: string }) => Promise<unknown>;
  teamFiles?: () => Promise<unknown>;
  teamProfile?: (input: Record<string, unknown>) => Promise<unknown>;
  teamWork?: (input: Record<string, unknown>) => Promise<unknown>;
  teamRemember?: (input: { topic: 'decisions' | 'shared'; text: string }) => Promise<unknown>;
  sessionMessage?: (input: Record<string, unknown>, senderSessionId: string | undefined) => Promise<unknown> | unknown;
  subagent?: (request: SubagentRequest, senderSessionId: string | undefined, signal?: AbortSignal) => Promise<unknown> | unknown;
  parentMessage?: (input: ParentMessageInput, senderSessionId: string | undefined) => Promise<unknown> | unknown;
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
    createMemoryWriteTool(options.workspaceRoot, options.memoryIndex),
    createSessionListTool(options.workspaceRoot),
    createSessionSearchTool(options.workspaceRoot),
    createSessionReadTool(),
    createSendMessageToOwnerTool(options.workspaceRoot, options.ownerMessageSend ?? unavailable('send_message_to_owner')),
    createInboxTool(options.inbox ?? unavailable('inbox')),
    createSessionMessageTool(options.sessionMessage ?? (async () => ({ status: 'unavailable' as const }))),
    createTeamDeliveryTool(options.teamDelivery ?? (async () => ({ status: 'unavailable', error: 'Team delivery is not available.' }))),
    createTeamSendTool(options.teamSend ?? unavailable('team_send')),
    createTeamGroupTool(options.teamGroup ?? unavailable('team_group')),
    createTeamHistoryTool(options.teamHistory ?? unavailable('team_history')),
    createTeamStatusTool(options.teamStatus ?? unavailable('team_status')),
    createTeamSendFileTool(options.teamSendFile ?? unavailable('team_send_file')),
    createTeamReceiveFileTool(options.teamReceiveFile ?? unavailable('team_receive_file')),
    createTeamFilesTool(options.teamFiles ?? unavailable('team_files')),
    createTeamProfileTool(options.teamProfile ?? unavailable('team_profile')),
    createTeamWorkTool(options.teamWork ?? unavailable('team_work')),
    createTeamRememberTool(
      options.teamRemember ?? (async () => ({ status: 'unavailable' as const, error: 'team_remember is not available in this session.' })),
    ),
    createSubagentTool(options.subagent ?? (async () => ({ status: 'unavailable' as const }))),
    createParentMessageTool(options.parentMessage ?? (async () => ({ status: 'unavailable' as const }))),
    createSubagentStopTool(options.subagentStop ?? (async () => ({ status: 'unavailable' as const }))),
    createScheduleTool(
      options.workspaceRoot,
      options.backgroundManage ??
        (async () => ({ status: 'unavailable' as const, error: 'No background host is attached to this session.' })),
    ),
    createMcpManagementTool(options.mcp, options.onMcpConnectionsChanged),
  ];
  definitions.push(...options.mcp.tools);
  return definitions;
}
