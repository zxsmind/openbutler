import { MAX_TOOL_INPUT_CHARS, type ToolDefinition } from './registry.js';

type SendOwnerMessage = (input: Record<string, unknown>, workspaceRoot: string) => Promise<unknown>;

export function createSendMessageToOwnerTool(workspaceRoot: string, send: SendOwnerMessage): ToolDefinition {
  return {
    providerId: 'host',
    name: 'send_message_to_owner',
    maxInputChars: MAX_TOOL_INPUT_CHARS,
    description:
      'Send an intentional message to the owner through the paired Telegram chat. This never sends to the terminal. At least one of text, imagePath or filePath is required. Include text and optionally attach one local image as a photo or one local file as a document. Use this for progress the owner should see, questions, or a final answer; ordinary assistant text and tool activity are not delivered to Telegram. When replying to inbox messages, include their ids in replyTo.',
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
      // No root-level anyOf: Google's function schema subset rejects required on
      // type-less branches and requires anyOf to be the only field on its node,
      // which no root object can satisfy while still declaring these properties.
      // The "at least one" rule lives in the description above and in execute.
    },
    effect: { change: 'none', data: 'sensitive', network: 'used', reversible: 'none', outbound: 'model-and-tool-server' },
    autoApprove: () => true,
    execute: async (input) => {
      const payload = ['text', 'imagePath', 'filePath'].some((field) => {
        const value = input[field];
        return typeof value === 'string' && value.trim() !== '';
      });
      if (!payload) return { error: 'Provide at least one of text, imagePath or filePath.' };
      return send(input, workspaceRoot);
    },
  };
}
