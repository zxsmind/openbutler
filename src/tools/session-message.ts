import type { ToolDefinition } from './registry.js';

const sessionMessageEffect = {
  change: 'none',
  data: 'sensitive',
  network: 'none',
  reversible: 'full',
  outbound: 'model',
} as const;

const MAX_SESSION_MESSAGE_CHARS = 2_000;

/**
 * The write side of the session tools (P3): the machine custodian can steer a live worker
 * with a short text message. The rules are enforced by the host, not here: only a
 * machine custodian session may send, the receiver must be a live worker
 * session, and the receiver is told the message comes from another Ranite session
 * that can never approve anything on its own.
 */
export function createSessionMessageTool(
  send: (input: Record<string, unknown>, senderSessionId: string | undefined) => Promise<unknown> | unknown,
): ToolDefinition {
  return {
    providerId: 'host',
    name: 'session_message',
    description: `Send a short text message into another running Ranite session on this machine (steering). Only the machine custodian may send, only to live worker sessions such as scheduled runs; worker-to-worker messages are refused. The receiver sees the text as a message from another Ranite session, never from the user, and it can never approve actions or change settings by itself. Use it to redirect or correct work in progress; read the worker first with session_read when its state is unclear. Text only, at most ${MAX_SESSION_MESSAGE_CHARS} characters.`,
    inputSchema: {
      type: 'object',
      properties: {
        session: {
          type: 'string',
          description: 'Full session id or a unique prefix of at least four hex characters of a live worker session.',
        },
        text: { type: 'string', description: `The message to deliver, at most ${MAX_SESSION_MESSAGE_CHARS} characters.` },
      },
      required: ['session', 'text'],
      additionalProperties: false,
    },
    effect: sessionMessageEffect,
    autoApprove: () => true,
    execute: async (input, _signal, context) => {
      const session = typeof input.session === 'string' ? input.session.trim() : '';
      const text = typeof input.text === 'string' ? input.text : '';
      if (!session || session.length > 64) {
        return { status: 'invalid', error: 'session must be a non-empty session id or prefix.' };
      }
      if (!text.trim() || text.length > MAX_SESSION_MESSAGE_CHARS) {
        return { status: 'invalid', error: `text must be non-empty and at most ${MAX_SESSION_MESSAGE_CHARS} characters.` };
      }
      try {
        return await send({ session, text }, context?.sessionId);
      } catch (error) {
        return {
          status: 'error',
          error: `The message could not be delivered: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    },
  };
}
