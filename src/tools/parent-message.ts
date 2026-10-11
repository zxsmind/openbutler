import type { ToolDefinition } from './registry.js';

const parentMessageEffect = {
  change: 'none',
  data: 'sensitive',
  network: 'none',
  reversible: 'full',
  outbound: 'model',
} as const;

const MAX_PARENT_MESSAGE_CHARS = 2_000;

/**
 * The worker side of background subagent notes: a background worker can leave a
 * short progress note for the parent session to poll. The rules are enforced by
 * the host, not here: only a live background worker may leave notes, and only the
 * recorded parent may read them with `subagent_poll`. Foreground workers never
 * receive this tool; their report is the return value of the subagent call.
 */
export function createParentMessageTool(
  send: (input: { text: string }, senderSessionId: string | undefined) => Promise<unknown> | unknown,
): ToolDefinition {
  return {
    providerId: 'host',
    name: 'parent_message',
    workerOnly: true,
    description: `Leave a short progress note for the parent session that started this background worker; it reads the note with subagent_poll when it wants an update. Nothing is pushed into the parent session. Rule: report at every milestone — what you completed, what remains, anything blocking you; on long tasks at least every ~10 tool calls, one or two sentences. Your final assistant message is the report it polls when the run ends. Text only, at most ${MAX_PARENT_MESSAGE_CHARS} characters.`,
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: `The message to deliver, at most ${MAX_PARENT_MESSAGE_CHARS} characters.` },
      },
      required: ['text'],
      additionalProperties: false,
    },
    effect: parentMessageEffect,
    autoApprove: () => true,
    execute: async (input, _signal, context) => {
      const text = typeof input.text === 'string' ? input.text : '';
      if (!text.trim() || text.length > MAX_PARENT_MESSAGE_CHARS) {
        return { status: 'invalid', error: `text must be non-empty and at most ${MAX_PARENT_MESSAGE_CHARS} characters.` };
      }
      try {
        return await send({ text }, context?.sessionId);
      } catch (error) {
        return {
          status: 'error',
          error: `The message could not be delivered: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    },
  };
}
