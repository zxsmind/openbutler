import type { ToolDefinition } from './registry.js';

const pollEffect = {
  change: 'none',
  data: 'sensitive',
  network: 'none',
  reversible: 'full',
  outbound: 'model',
} as const;

/**
 * The parent side of background subagent polling: a session that started a worker
 * checks it — live status, the interim notes left since the last check, and the
 * final report once finished. Nothing is ever pushed into this session; poll when
 * an update is wanted. Only the recorded parent of a worker may poll it.
 */
export function createSubagentPollTool(
  poll: (input: { session: string }, senderSessionId: string | undefined) => Promise<unknown> | unknown,
): ToolDefinition {
  return {
    providerId: 'host',
    name: 'subagent_poll',
    description: `Check a worker session you started: whether it is still running or finished, the interim notes it left since your last check, and its final report once finished. Also returns host-observed activity — toolCalls (how many tool calls so far), lastTool (the last one, e.g. host:glob), and elapsedSec since the worker started — so progress is visible without reading the transcript. Nothing is pushed into this session on its own — poll when you want an update. Only the parent session that started the worker may poll it; pass the worker session id from the subagent call result (full id or a unique prefix of at least four hex characters).`,
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
    effect: pollEffect,
    autoApprove: () => true,
    execute: async (input, _signal, context) => {
      const session = typeof input.session === 'string' ? input.session.trim() : '';
      if (!session) {
        return { status: 'invalid', error: 'session must be a non-empty session id or prefix.' };
      }
      try {
        return await poll({ session }, context?.sessionId);
      } catch (error) {
        return {
          status: 'error',
          error: `The worker could not be polled: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    },
  };
}
