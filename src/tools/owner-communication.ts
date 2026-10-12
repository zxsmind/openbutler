import type { JSONValue } from 'ai';
import { MAX_TOOL_INPUT_CHARS, type ToolDefinition } from './registry.js';

type SendOwnerMessage = (input: Record<string, unknown>, workspaceRoot: string) => Promise<unknown>;
type ReadOwnerMessages = (limit: number, acknowledge?: string[]) => Promise<unknown>;

export function createSendMessageToOwnerTool(workspaceRoot: string, send: SendOwnerMessage): ToolDefinition {
  return {
    providerId: 'host',
    name: 'send_message_to_owner',
    maxInputChars: MAX_TOOL_INPUT_CHARS,
    description:
      'Send an intentional message to the owner through the paired Telegram chat. This never sends to the terminal. Include text and optionally attach one local image as a photo or one local file as a document. Use this for progress the owner should see, questions, or a final answer; ordinary assistant text and tool activity are not delivered to Telegram. When replying to inbox messages, include their ids in replyTo.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        text: { type: 'string', maxLength: 28_000, description: 'Message text or media caption.' },
        imagePath: { type: 'string', description: 'Optional local image path; Telegram sends it as a photo.' },
        filePath: { type: 'string', description: 'Optional local file path; Telegram sends it as a document.' },
        replyTo: {
          type: 'array',
          items: { type: 'string' },
          description: 'Owner inbox message ids this message answers. Omit for a proactive update.',
        },
      },
      anyOf: [{ required: ['text'] }, { required: ['imagePath'] }, { required: ['filePath'] }],
    },
    effect: { change: 'none', data: 'sensitive', network: 'used', reversible: 'none', outbound: 'model-and-tool-server' },
    autoApprove: () => true,
    execute: (input) => send(input, workspaceRoot),
  };
}

export function createReadOwnerMessagesTool(read: ReadOwnerMessages): ToolDefinition {
  return {
    providerId: 'host',
    name: 'read_owner_messages',
    maxInputChars: 128,
    description:
      'Read newly arrived messages from the authenticated owner inbox, including their source, timestamp, text, and any image. Messages returned here are added to the conversation as owner user messages. When a message needs no outward response, pass its id in acknowledge after handling it; this closes the request without sending a Telegram message.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        limit: { type: 'integer', minimum: 1, maximum: 20, description: 'Maximum new messages to read; defaults to 10.' },
        acknowledge: {
          type: 'array',
          maxItems: 20,
          items: { type: 'string' },
          description: 'Ids of previously read owner messages that are handled and need no Telegram reply.',
        },
      },
    },
    effect: { change: 'none', data: 'sensitive', network: 'none', reversible: 'full', outbound: 'model' },
    autoApprove: () => true,
    toModelOutput: (output) => ({ type: 'json', value: output as JSONValue }),
    execute: (input) => {
      const limit = input.limit ?? 10;
      if (!Number.isSafeInteger(limit) || Number(limit) < 1 || Number(limit) > 20)
        return Promise.resolve({ status: 'invalid', error: 'limit must be an integer between 1 and 20.' });
      const acknowledge = input.acknowledge ?? [];
      if (!Array.isArray(acknowledge) || acknowledge.length > 20 || !acknowledge.every((id) => typeof id === 'string'))
        return Promise.resolve({ status: 'invalid', error: 'acknowledge must be an array of up to 20 owner inbox message ids.' });
      return read(Number(limit), acknowledge as string[]);
    },
  };
}
