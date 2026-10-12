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

export interface ToolCatalogueOptions {
  workspaceRoot: string;
  inputModalities: readonly string[];
  memoryIndex: MemoryIndex;
  mcp: McpConnectionManager;
  /** Rebuilds the registry after an MCP connection change. */
  onMcpConnectionsChanged: () => void;
  backgroundManage?: (input: Record<string, unknown>, workspaceRoot: string) => Promise<unknown>;
  ownerMessageSend?: (input: Record<string, unknown>, workspaceRoot: string) => Promise<unknown>;
  ownerInboxRead?: (limit: number, acknowledge?: string[]) => Promise<unknown>;
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
 */
export function createToolCatalogue(options: ToolCatalogueOptions): ToolDefinition[] {
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
    ...(options.ownerMessageSend ? [createSendMessageToOwnerTool(options.workspaceRoot, options.ownerMessageSend)] : []),
    ...(options.ownerInboxRead ? [createReadOwnerMessagesTool(options.ownerInboxRead)] : []),
    ...(options.sessionMessage ? [createSessionMessageTool(options.sessionMessage)] : []),
    ...(options.subagent ? [createSubagentTool(options.subagent)] : []),
    ...(options.parentMessage ? [createParentMessageTool(options.parentMessage)] : []),
    ...(options.subagentPoll ? [createSubagentPollTool(options.subagentPoll)] : []),
    ...(options.subagentStop ? [createSubagentStopTool(options.subagentStop)] : []),
    createMcpManagementTool(options.mcp, options.onMcpConnectionsChanged),
  ];
  if (options.backgroundManage) {
    definitions.push(createBackgroundManagementTool(options.workspaceRoot, options.backgroundManage));
  }
  definitions.push(...options.mcp.tools);
  return definitions;
}
