import { MAX_TOOL_INPUT_CHARS, type ToolDefinition } from './registry.js';

type SendOwnerMessage = (input: Record<string, unknown>, workspaceRoot: string) => Promise<unknown>;

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
