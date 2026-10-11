import { MAX_TOOL_INPUT_CHARS, type ToolDefinition } from './registry.js';

export function createNotifyOwnerTool(
  workspaceRoot: string,
  send: (input: Record<string, unknown>, workspaceRoot: string) => Promise<unknown>,
): ToolDefinition {
  return {
    providerId: 'host',
    name: 'notify_owner',
    maxInputChars: MAX_TOOL_INPUT_CHARS,
    description:
      'Send a separate proactive message to the configured machine owner. Do not duplicate an ordinary assistant reply: the host delivers those to the current reply channel. channel auto prefers a connected owner terminal, then the paired Telegram chat; terminal or telegram explicitly selects that owner channel. Arbitrary recipients are not supported. The result distinguishes queued delivery from confirmed delivery.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['message'],
      properties: {
        message: { type: 'string' },
        title: { type: 'string' },
        channel: { type: 'string', enum: ['auto', 'terminal', 'telegram'] },
      },
    },
    effect: { change: 'none', data: 'local', network: 'used', reversible: 'full', outbound: 'model-and-tool-server' },
    autoApprove: () => true,
    execute: (input) => send(input, workspaceRoot),
  };
}
