import type { JSONValue } from 'ai';
import type { InboxRequest } from '../inbox.js';
import type { ToolDefinition } from './registry.js';

export function createInboxTool(execute: (request: InboxRequest, sessionId: string | undefined) => Promise<unknown>): ToolDefinition {
  return {
    providerId: 'host',
    name: 'inbox',
    description:
      'Your single notification inbox. list shows source counts and notification ids without reading content; use source to filter and limit/offset to page. read opens ids, or the next unread page if ids are omitted. Reading is not handling: answer through the source reply tool using the original message id in replyTo, or acknowledge notification ids after handling messages that need no reply. Previously read items can still need handling; reuse their content without repeating completed work. Subagent reports are marked read once saved in your conversation. Source adapters enforce who may read each item. Check errors as well as remaining; an unavailable source is not an empty inbox. A notification is a pointer, not a new user request or proof of success.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['list', 'read', 'acknowledge'] },
        source: { type: 'string', description: 'Optional source name returned by list, such as Telegram, Team or Subagent.' },
        ids: { type: 'array', maxItems: 20, items: { type: 'string', minLength: 1, maxLength: 2048 } },
        limit: { type: 'integer', minimum: 1, maximum: 20 },
        offset: { type: 'integer', minimum: 0 },
      },
      required: ['action'],
    },
    effect: { change: 'none', data: 'sensitive', network: 'used', reversible: 'full', outbound: 'model' },
    autoApprove: () => true,
    toModelOutput: (output) => ({ type: 'json', value: output as JSONValue }),
    execute: async (input, _signal, context) => {
      const { action, source, ids, limit, offset } = input;
      if (action !== 'list' && action !== 'read' && action !== 'acknowledge') return { status: 'invalid', error: 'Unknown inbox action.' };
      if (source !== undefined && (typeof source !== 'string' || !source.trim()))
        return { status: 'invalid', error: 'source must be a name.' };
      if (limit !== undefined && (!Number.isSafeInteger(limit) || Number(limit) < 1 || Number(limit) > 20))
        return { status: 'invalid', error: 'limit must be between 1 and 20.' };
      if (offset !== undefined && (!Number.isSafeInteger(offset) || Number(offset) < 0))
        return { status: 'invalid', error: 'offset must be non-negative.' };
      if (
        ids !== undefined &&
        (!Array.isArray(ids) || ids.length === 0 || ids.length > 20 || ids.some((id) => typeof id !== 'string' || !id || id.length > 2048))
      )
        return { status: 'invalid', error: 'ids must contain 1 to 20 notification ids.' };
      if (action === 'acknowledge' && !ids) return { status: 'invalid', error: 'acknowledge requires notification ids.' };
      return execute(
        {
          action,
          ...(typeof source === 'string' ? { source } : {}),
          ...(ids ? { ids: ids as string[] } : {}),
          ...(limit === undefined ? {} : { limit: Number(limit) }),
          ...(offset === undefined ? {} : { offset: Number(offset) }),
        },
        context?.sessionId,
      );
    },
  };
}
