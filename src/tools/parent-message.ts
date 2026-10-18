import { WORKER_NOTE_KINDS } from '../worker-records.js';
import type { ParentMessageInput, WorkerNoteKind } from '../worker-records.js';
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
 * short progress note for its parent; important notes also produce a durable wake signal. The rules are enforced by
 * the host, not here: only a live background worker may leave notes, and only the
 * recorded parent may read them with `inbox`. Foreground workers never
 * receive this tool; their report is the return value of the subagent call.
 */
export function createParentMessageTool(
  send: (input: ParentMessageInput, senderSessionId: string | undefined) => Promise<unknown> | unknown,
): ToolDefinition {
  return {
    providerId: 'host',
    name: 'parent_message',
    description: `Leave a short progress note, material question, or blocker for the parent session that started this background worker. The parent retrieves the text through inbox. Progress notes stay quiet; use kind blocked or question for a decision-worthy event that wakes your parent. A wake does not mean the parent has read or resolved it. Report meaningful milestones and changed assumptions, with the evidence, remaining work, or decision needed; avoid repeated status with no new information. Your final assistant message is the complete report it polls when the run ends. Text only, at most ${MAX_PARENT_MESSAGE_CHARS} characters.`,
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: `The message to deliver, at most ${MAX_PARENT_MESSAGE_CHARS} characters.` },
        kind: {
          type: 'string',
          enum: [...WORKER_NOTE_KINDS],
          description:
            'progress is quiet (default); blocked/question persist an event and wake your parent unless the owner has paused it.',
        },
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
      const kind = input.kind;
      if (kind !== undefined && (typeof kind !== 'string' || !WORKER_NOTE_KINDS.includes(kind as WorkerNoteKind)))
        return { status: 'invalid', error: 'kind must be progress, blocked or question.' };
      try {
        return await send({ text, ...(kind === undefined ? {} : { kind: kind as WorkerNoteKind }) }, context?.sessionId);
      } catch (error) {
        return {
          status: 'error',
          error: `The message could not be delivered: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    },
  };
}
