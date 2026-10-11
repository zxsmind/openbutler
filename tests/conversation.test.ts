import { expect, it } from 'vitest';
import type { ModelMessage } from 'ai';
import {
  COMPACTION_CONTINUE_MESSAGE,
  COMPACTION_SUMMARY_MARKER,
  TOOL_REFERENCE_MARKER,
  repairQueuedMessageOrder,
  retireCoveredToolPreviews,
} from '../src/conversation.js';

const queued = (text: string): ModelMessage => ({
  role: 'user',
  content: [{ type: 'text', text }],
  providerOptions: { ranite: { queuedMessageId: text } },
});
const call = (id: string): ModelMessage => ({
  role: 'assistant',
  content: [{ type: 'tool-call', toolCallId: id, toolName: 'inspect', input: {} }],
});
const result = (id: string): ModelMessage => ({
  role: 'tool',
  content: [{ type: 'tool-result', toolCallId: id, toolName: 'inspect', output: { type: 'text', value: 'Exact original result' } }],
});
const preview = (id: string): ModelMessage => ({
  role: 'assistant',
  content:
    TOOL_REFERENCE_MARKER +
    JSON.stringify({
      batchId: id,
      toolCallId: id,
      toolName: 'inspect',
      input: 'Original input',
      outputType: 'text',
      output: 'Original output',
    }),
});

it('repairs the persisted queue-index bug without removing or fabricating any message', () => {
  const one = queued('one');
  const two = queued('two');
  const toolCall = call('next');
  const toolResult = result('next');
  const source = [one, toolCall, two, toolResult];
  expect(repairQueuedMessageOrder(source)).toEqual([one, two, toolCall, toolResult]);
  expect(source).toEqual([one, toolCall, two, toolResult]);
});

it('leaves an unresolved call and an untagged user message intact', () => {
  const unresolved = [call('unresolved'), queued('pending')];
  expect(repairQueuedMessageOrder(unresolved)).toBe(unresolved);
  const untagged: ModelMessage[] = [call('next'), { role: 'user', content: 'Explicit untagged input' }, result('next')];
  expect(repairQueuedMessageOrder(untagged)).toBe(untagged);
});

it('preserves the order of multiple queued messages across a parallel tool batch', () => {
  const one = queued('one');
  const two = queued('two');
  const batch: ModelMessage = {
    role: 'assistant',
    content: [
      { type: 'tool-call', toolCallId: 'a', toolName: 'inspect', input: {} },
      { type: 'tool-call', toolCallId: 'b', toolName: 'inspect', input: {} },
    ],
  };
  expect(repairQueuedMessageOrder([batch, one, result('a'), two, result('b')])).toEqual([one, two, batch, result('a'), result('b')]);
});

it('retires only previews covered by a completed saved checkpoint, preserving all newer native exchanges', () => {
  const checkpoint: ModelMessage = {
    role: 'assistant',
    content: COMPACTION_SUMMARY_MARKER + 'Successful checkpoint',
    providerOptions: { ranite: { compactionCheckpoint: true } },
  };
  const user: ModelMessage = { role: 'user', content: 'Exact user requirement' };
  const fresh = [call('fresh'), result('fresh')];
  const source = [checkpoint, user, preview('old'), preview('latest'), COMPACTION_CONTINUE_MESSAGE, ...fresh];
  expect(retireCoveredToolPreviews(source)).toEqual([checkpoint, user, preview('latest'), COMPACTION_CONTINUE_MESSAGE, ...fresh]);
  expect(source).toHaveLength(7);
});

it('does not retire tool bodies when there is no committed checkpoint', () => {
  const source = [preview('old'), preview('latest'), COMPACTION_CONTINUE_MESSAGE];
  expect(retireCoveredToolPreviews(source)).toBe(source);
});
