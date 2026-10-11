import type { ModelMessage } from 'ai';

export const COMPACTION_SUMMARY_MARKER = 'Ranite conversation summary (context only):\n';
export const TOOL_REFERENCE_MARKER = 'Ranite tool exchange (raw context preview):\n';
export const COMPACTION_CONTINUE_MESSAGE: ModelMessage = {
  role: 'user',
  content:
    'Continue the unfinished user request from the compacted history. Use the summary to recover the current goal, constraints, completed work, and next action.',
  providerOptions: { ranite: { compactionControl: true } },
};

const TOOL_PREVIEW_FIELD_CHARS = 8_192;
const TOOL_PREVIEW_BATCH_CHARS = 32_768;

export function appendTranscriptArchiveReference(content: string, archivePath: string): string {
  const reference = `\n\nRanite transcript archive (original messages and tool results): ${archivePath}`;
  return content.includes(reference) ? content : content + reference;
}

export interface ToolReference {
  batchId: string;
  toolCallId: string;
  toolName: string;
  input: string;
  outputType: string;
  output: string;
}

export function parseToolReference(message: ModelMessage): ToolReference | null {
  if (message.role !== 'assistant' || typeof message.content !== 'string' || !message.content.startsWith(TOOL_REFERENCE_MARKER))
    return null;
  try {
    const value = JSON.parse(message.content.slice(TOOL_REFERENCE_MARKER.length)) as Record<string, unknown>;
    if (
      !value ||
      typeof value !== 'object' ||
      !['batchId', 'toolCallId', 'toolName', 'input', 'outputType', 'output'].every((key) => typeof value[key] === 'string')
    )
      return null;
    return value as unknown as ToolReference;
  } catch {
    return null;
  }
}

/** Called only after a completed checkpoint covers these tool exchanges. */
export function retainLatestToolPreviews(messages: ModelMessage[]): ModelMessage[] {
  const references = messages.map(parseToolReference);
  const latestBatch = references.findLast((reference) => reference !== null)?.batchId;
  if (latestBatch === undefined) return messages;
  const count = references.filter((reference) => reference?.batchId === latestBatch).length;
  const fieldLimit = Math.min(TOOL_PREVIEW_FIELD_CHARS, Math.floor(TOOL_PREVIEW_BATCH_CHARS / (count * 2)));
  let changed = false;
  const retained = messages.flatMap((message, index): ModelMessage[] => {
    const reference = references[index];
    if (!reference) return [message];
    if (reference.batchId !== latestBatch) {
      changed = true;
      return [];
    }
    const input = truncateHeadAndTail(reference.input, fieldLimit);
    const output = truncateHeadAndTail(reference.output, fieldLimit);
    if (input === reference.input && output === reference.output) return [message];
    changed = true;
    return [{ ...message, role: 'assistant', content: TOOL_REFERENCE_MARKER + JSON.stringify({ ...reference, input, output }) }];
  });
  return changed ? retained : messages;
}

/** Finish the projection of legacy saved checkpoints without summarizing fresh messages again. */
export function retireCoveredToolPreviews(messages: ModelMessage[]): ModelMessage[] {
  const boundary = messages.findLastIndex(
    (message) =>
      message.role === 'user' &&
      message.content === COMPACTION_CONTINUE_MESSAGE.content &&
      message.providerOptions?.ranite?.compactionControl === true,
  );
  if (
    boundary < 0 ||
    !messages
      .slice(0, boundary)
      .some(
        (message, index) =>
          message.role === 'assistant' &&
          typeof message.content === 'string' &&
          message.content.startsWith(COMPACTION_SUMMARY_MARKER) &&
          (message.providerOptions?.ranite?.compactionCheckpoint === true || index === 0),
      )
  )
    return messages;
  const prefix = messages.slice(0, boundary + 1);
  const retained = retainLatestToolPreviews(prefix);
  return retained === prefix ? messages : [...retained, ...messages.slice(boundary + 1)];
}

/** Repair the historical queue-index bug using existing results; never invent or discard a tool result. */
export function repairQueuedMessageOrder(messages: ModelMessage[]): ModelMessage[] {
  const resultPositions = new Map<string, number>();
  messages.forEach((message, index) => {
    if (message.role === 'tool')
      for (const part of message.content) {
        if (part.type === 'tool-result') resultPositions.set(part.toolCallId, index);
      }
  });
  const pending = new Set<string>();
  const moves = new Map<number, ModelMessage[]>();
  const moved = new Set<number>();
  let boundary = -1;
  messages.forEach((message, index) => {
    if (message.role === 'assistant' && Array.isArray(message.content))
      for (const part of message.content) {
        if (part.type === 'tool-call' && !part.providerExecuted && (resultPositions.get(part.toolCallId) ?? -1) > index) {
          if (pending.size === 0) boundary = index;
          pending.add(part.toolCallId);
        }
      }
    if (message.role === 'tool')
      for (const part of message.content) {
        if (part.type === 'tool-result') pending.delete(part.toolCallId);
      }
    if (message.role === 'user' && typeof message.providerOptions?.ranite?.queuedMessageId === 'string' && pending.size > 0) {
      const group = moves.get(boundary) ?? [];
      group.push(message);
      moves.set(boundary, group);
      moved.add(index);
    }
  });
  if (moves.size === 0) return messages;
  return messages.flatMap((message, index) => [...(moves.get(index) ?? []), ...(moved.has(index) ? [] : [message])]);
}

function truncateHeadAndTail(value: string, maximumChars: number): string {
  if (maximumChars <= 0) return '';
  if (value.length <= maximumChars) return value;
  const marker = '\n… [middle truncated] …\n';
  if (maximumChars <= marker.length) return marker.slice(0, maximumChars);
  const remaining = maximumChars - marker.length;
  const headLength = Math.ceil(remaining * 0.75);
  return `${value.slice(0, headLength)}${marker}${value.slice(-(remaining - headLength))}`;
}
