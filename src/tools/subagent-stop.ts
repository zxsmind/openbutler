import type { ToolDefinition } from './registry.js';

const stopEffect = {
  change: 'none',
  data: 'sensitive',
  network: 'none',
  reversible: 'full',
  outbound: 'model',
} as const;

/**
 * The kill switch for background workers: a session that started a worker stops
 * its run immediately. Queued messages are dropped and a pending approval is
 * denied; the session and its transcript stay saved and readable. Only the
 * recorded parent of a worker may stop it.
 */
export function createSubagentStopTool(
  stop: (input: { session: string }, senderSessionId: string | undefined) => Promise<unknown> | unknown,
): ToolDefinition {
  return {
    providerId: 'host',
    name: 'subagent_stop',
    description: `Stop a worker session you started: aborts its run immediately, drops its queued messages, and denies a pending approval. The session and its transcript stay saved and readable. Only the parent session that started the worker may stop it; pass the worker session id from the subagent call result (full id or a unique prefix of at least four hex characters).`,
    inputSchema: {
      type: 'object',
      properties: {
        session: {
          type: 'string',
          description: 'Full session id or a unique prefix of at least four hex characters of a worker you started.',
        },
      },
      required: ['session'],
      additionalProperties: false,
    },
    effect: stopEffect,
    autoApprove: () => true,
    execute: async (input, _signal, context) => {
      const session = typeof input.session === 'string' ? input.session.trim() : '';
      if (!session) {
        return { status: 'invalid', error: 'session must be a non-empty session id or prefix.' };
      }
      try {
        return await stop({ session }, context?.sessionId);
      } catch (error) {
        return {
          status: 'error',
          error: `The worker could not be stopped: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    },
  };
}
