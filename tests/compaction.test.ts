import { generateText, jsonSchema, tool, type ModelMessage } from 'ai';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { MockLanguageModelV3 } from 'ai/test';
import type { LanguageModelV3StreamPart, LanguageModelV3StreamResult } from '@ai-sdk/provider';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getAgentContext, runAgent } from '../src/agent.js';
import { createImageToolResult } from '../src/image.js';
import {
  COMPACTION_CONTINUE_MESSAGE,
  COMPACTION_PROMPT,
  COMPACTION_SUMMARY_MARKER,
  TOOL_REFERENCE_MARKER,
  compactConversation,
  estimateContextTokens,
} from '../src/compaction.js';

let dataDir: string;
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'ranite-compaction-check-'));
  vi.stubEnv('RANITE_DATA_DIR', dataDir);
});
afterEach(() => {
  vi.unstubAllEnvs();
  if (dirname(resolve(dataDir)) !== resolve(tmpdir()) || !basename(dataDir).startsWith('ranite-compaction-check-'))
    throw new Error('Unsafe fixture cleanup path.');
  rmSync(dataDir, { recursive: true, force: true });
});

function stream(parts: LanguageModelV3StreamPart[], reason: 'stop' | 'length' | 'tool-calls' = 'stop'): LanguageModelV3StreamResult {
  return {
    stream: new ReadableStream({
      start(controller) {
        controller.enqueue({ type: 'stream-start', warnings: [] });
        for (const part of parts) controller.enqueue(part);
        controller.enqueue({
          type: 'finish',
          finishReason: { unified: reason, raw: reason },
          usage: {
            inputTokens: { total: 123, noCache: 123, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: 20, text: 20, reasoning: 0 },
          },
        });
        controller.close();
      },
    }),
  };
}

function textStream(text: string, reason: 'stop' | 'length' = 'stop') {
  return stream(
    [
      { type: 'text-start', id: 'text' },
      { type: 'text-delta', id: 'text', delta: text },
      { type: 'text-end', id: 'text' },
    ],
    reason,
  );
}

const schema = jsonSchema<Record<string, unknown>>({ type: 'object', properties: {} });

describe('full-context LLM compaction', () => {
  it('keeps messages drained together at the same completed tool boundary on every subsequent step', async () => {
    const model = new MockLanguageModelV3({
      doStream: [
        stream([{ type: 'tool-call', toolCallId: 'first-batch', toolName: 'inspect', input: '{}' }], 'tool-calls'),
        stream([{ type: 'tool-call', toolCallId: 'next-batch', toolName: 'inspect', input: '{}' }], 'tool-calls'),
        textStream('Done.'),
      ],
    });
    const summaryModel = new MockLanguageModelV3({ doStream: async () => textStream('Complete checkpoint.') });
    const queued: ModelMessage[][] = [
      [],
      [
        { role: 'user', content: [{ type: 'text', text: 'Queued one' }] },
        { role: 'user', content: [{ type: 'text', text: 'Queued two' }] },
      ],
      [],
    ];
    let step = 0;
    const result = await runAgent({
      model,
      messages: [{ role: 'user', content: 'Original task' }],
      tools: { inspect: tool({ inputSchema: schema, execute: async () => 'Complete tool result' }) },
      takeQueuedMessages: () => queued.shift() ?? [],
      compactBeforeStep: async (context) =>
        ++step === 3 ? compactConversation({ ...context, model: summaryModel, contextWindowTokens: null, force: true }) : null,
    });
    expect(summaryModel.doStreamCalls).toHaveLength(1);
    const messages = result.response.messages;
    const one = messages.findIndex(
      (message) =>
        message.role === 'user' &&
        Array.isArray(message.content) &&
        message.content.some((part) => part.type === 'text' && part.text === 'Queued one'),
    );
    const two = messages.findIndex(
      (message) =>
        message.role === 'user' &&
        Array.isArray(message.content) &&
        message.content.some((part) => part.type === 'text' && part.text === 'Queued two'),
    );
    const call = messages.findIndex(
      (message) =>
        message.role === 'assistant' &&
        Array.isArray(message.content) &&
        message.content.some((part) => part.type === 'tool-call' && part.toolCallId === 'next-batch'),
    );
    expect(one).toBeGreaterThanOrEqual(0);
    expect(two).toBe(one + 1);
    expect(call).toBeGreaterThan(two);
  });

  it('replaces summarized historical tool bodies with the checkpoint while keeping dialogue and the latest batch', async () => {
    const references = Array.from({ length: 80 }, (_, index): ModelMessage => ({
      role: 'assistant',
      content:
        TOOL_REFERENCE_MARKER +
        JSON.stringify({
          batchId: `old-${index}`,
          toolCallId: `old-${index}`,
          toolName: 'execute_command',
          input: `Historical input ${index} ` + 'x'.repeat(1_000),
          outputType: 'text',
          output: `Historical output ${index} ` + 'y'.repeat(1_000),
        }),
    }));
    const user: ModelMessage = { role: 'user', content: 'Keep the complete user request.' };
    const assistant: ModelMessage = { role: 'assistant', content: 'Keep the complete assistant reply.' };
    const messages: ModelMessage[] = [
      {
        role: 'assistant',
        content: COMPACTION_SUMMARY_MARKER + 'Earlier checkpoint',
        providerOptions: { ranite: { compactionCheckpoint: true } },
      },
      user,
      assistant,
      ...references,
    ];
    const source = structuredClone(messages);
    const model = new MockLanguageModelV3({ doStream: async () => textStream('New checkpoint covering all historical facts.') });
    const result = await compactConversation({ system: 'Permanent policy', messages, model, contextWindowTokens: null, force: true });
    const previews = result!.messages.filter(
      (message) => message.role === 'assistant' && typeof message.content === 'string' && message.content.startsWith(TOOL_REFERENCE_MARKER),
    );
    expect(previews).toHaveLength(1);
    expect(JSON.parse((previews[0]!.content as string).slice(TOOL_REFERENCE_MARKER.length)).toolCallId).toBe('old-79');
    expect(result!.messages).toContainEqual(user);
    expect(result!.messages).toContainEqual(assistant);
    expect(JSON.stringify(model.doStreamCalls[0]!.prompt)).toContain('Historical output 0 ' + 'y'.repeat(1_000));
    expect(messages).toEqual(source);
  });

  it('bounds the total latest-batch text preview without dropping any latest tool identity', async () => {
    const calls = Array.from({ length: 8 }, (_, index) => ({
      type: 'tool-call' as const,
      toolCallId: `parallel-${index}`,
      toolName: 'inspect',
      input: { payload: 'i'.repeat(20_000) },
    }));
    const messages: ModelMessage[] = [
      { role: 'user', content: 'Inspect all results.' },
      { role: 'assistant', content: calls },
      {
        role: 'tool',
        content: calls.map((call) => ({
          type: 'tool-result',
          toolCallId: call.toolCallId,
          toolName: call.toolName,
          output: { type: 'text', value: 'o'.repeat(20_000) },
        })),
      },
    ];
    const model = new MockLanguageModelV3({ doStream: async () => textStream('A complete checkpoint of all eight results.') });
    const result = await compactConversation({ system: 'Policy', messages, model, contextWindowTokens: null, force: true });
    const previews = result!.messages.flatMap((message) =>
      message.role === 'assistant' && typeof message.content === 'string' && message.content.startsWith(TOOL_REFERENCE_MARKER)
        ? [JSON.parse(message.content.slice(TOOL_REFERENCE_MARKER.length))]
        : [],
    );
    expect(previews.map((preview) => preview.toolCallId)).toEqual(calls.map((call) => call.toolCallId));
    expect(previews.reduce((sum, preview) => sum + preview.input.length + preview.output.length, 0)).toBeLessThanOrEqual(32_768);
  });

  it('keeps the normal OpenAI-compatible request intact and only appends the summary user message', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      const chunk = {
        id: 'fixture',
        created: 0,
        model: 'fixture',
        choices: [{ index: 0, delta: { role: 'assistant', content: 'Fixture checkpoint.' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 100, completion_tokens: 3, total_tokens: 103 },
      };
      return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
    });
    const { createOpenAICompatible } = await import('@ai-sdk/openai-compatible');
    const model = createOpenAICompatible({
      name: 'fixture',
      baseURL: 'http://fixture.invalid/v1',
      apiKey: 'fixture',
      includeUsage: true,
      fetch,
    }).chatModel('fixture');
    const original: ModelMessage[] = [
      { role: 'user', content: 'Inspect the workspace.' },
      {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'Preserve this thinking.' },
          { type: 'text', text: 'Checking.' },
          { type: 'tool-call', toolCallId: 'previous-call', toolName: 'inspect', input: { path: 'source.ts' } },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'previous-call',
            toolName: 'inspect',
            output: { type: 'json', value: { content: 'Original result' } },
          },
        ],
      },
    ];
    const snapshot = structuredClone(original);
    const execute = vi.fn();
    const tools = { inspect: tool({ description: 'Inspect the workspace', inputSchema: schema, execute }) };
    const providerOptions = { fixture: { reasoningEffort: 'xhigh', cache_salt: 'conversation-cache' } };
    await runAgent({ model, messages: original, tools, getProviderOptions: () => providerOptions });
    let checked = false;
    await runAgent({
      model,
      messages: original,
      tools,
      getProviderOptions: () => providerOptions,
      compactBeforeStep: async (context) => {
        if (checked) return null;
        checked = true;
        return compactConversation({ ...context, model, contextWindowTokens: null, force: true });
      },
    });
    expect(bodies).toHaveLength(3);
    const { messages: normalMessages, ...normalSettings } = bodies[0]!;
    const { messages: summaryMessages, ...summarySettings } = bodies[1]!;
    expect(summarySettings).toEqual(normalSettings);
    expect((summaryMessages as unknown[]).slice(0, -1)).toEqual(normalMessages);
    expect((summaryMessages as unknown[]).at(-1)).toEqual({ role: 'user', content: COMPACTION_PROMPT });
    expect(original).toEqual(snapshot);
    expect(execute).not.toHaveBeenCalled();
  });

  it('adds the archive location to the completed checkpoint without changing the summary request', async () => {
    const model = new MockLanguageModelV3({ doStream: async () => textStream('Complete checkpoint.') });
    const archivePath = 'C:/data/ranite/sessions/fixture.json';
    const result = await compactConversation({
      system: 'Permanent policy',
      messages: [{ role: 'user', content: 'Original task' }],
      model,
      archivePath,
      contextWindowTokens: null,
      force: true,
    });
    expect(model.doStreamCalls[0]!.prompt.at(-1)).toEqual({ role: 'user', content: [{ type: 'text', text: COMPACTION_PROMPT }] });
    expect(JSON.stringify(model.doStreamCalls[0]!.prompt)).not.toContain(archivePath);
    expect(result!.messages[0]!.content as string).toContain(archivePath);
  });

  it('does not execute a tool if the model attempts a tool call while summarizing', async () => {
    const execute = vi.fn();
    const messages: ModelMessage[] = [{ role: 'user', content: 'Original request' }];
    const model = new MockLanguageModelV3({
      doStream: async () => stream([{ type: 'tool-call', toolCallId: 'unexpected', toolName: 'inspect', input: '{}' }], 'tool-calls'),
    });
    await expect(
      compactConversation({
        system: 'Original system',
        messages,
        model,
        tools: { inspect: tool({ inputSchema: schema, execute }) },
        contextWindowTokens: null,
        force: true,
      }),
    ).rejects.toThrow(/text-only compaction summary/);
    expect(execute).not.toHaveBeenCalled();
    expect(messages).toEqual([{ role: 'user', content: 'Original request' }]);
    expect(model.doStreamCalls).toHaveLength(1);
  });

  it('sends the complete active context in one provider request without rewriting or truncating it', async () => {
    const reasoning = 'preserved reasoning '.repeat(900);
    const input = { command: 'complete command '.repeat(900) };
    const output = { report: 'complete tool output '.repeat(2_000), data: 'data must not be omitted '.repeat(100) };
    const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6C9sAAAAASUVORK5CYII=', 'base64');
    const original: ModelMessage[] = [
      { role: 'assistant', content: COMPACTION_SUMMARY_MARKER + 'Earlier objective and decisions' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Original user request' },
          { type: 'image', image, mediaType: 'image/png' },
        ],
      },
      {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: reasoning },
          { type: 'text', text: 'Assistant decision' },
          { type: 'tool-call', toolCallId: 'call-1', toolName: 'inspect', input },
        ],
      },
      {
        role: 'tool',
        content: [{ type: 'tool-result', toolCallId: 'call-1', toolName: 'inspect', output: { type: 'json', value: output } }],
      },
      { role: 'user', content: 'Latest user correction' },
    ];
    const snapshot = JSON.stringify(original);
    const execute = vi.fn();
    const model = new MockLanguageModelV3({ doStream: async () => textStream('The LLM continuation checkpoint') });
    const deltas: string[] = [];
    const onStart = vi.fn();
    const result = await compactConversation({
      ...getAgentContext(original, undefined, dataDir, undefined, true, undefined, '11111111-1111-4111-8111-111111111111'),
      model,
      tools: { inspect: tool({ description: 'Inspect context', inputSchema: schema, execute }) },
      contextWindowTokens: 250_000,
      force: true,
      onStart,
      onTextDelta: (delta) => deltas.push(delta),
    });

    expect(model.doStreamCalls).toHaveLength(1);
    const request = model.doStreamCalls[0]!;
    const serialized = JSON.stringify(request.prompt);
    for (const content of [
      'Earlier objective and decisions',
      'Original user request',
      'Assistant decision',
      reasoning,
      input.command,
      output.report,
      output.data,
      'Latest user correction',
    ]) {
      expect(serialized).toContain(content);
    }
    expect(request.prompt.at(-1)).toEqual({ role: 'user', content: [{ type: 'text', text: COMPACTION_PROMPT }] });
    expect(request.prompt.find((message) => message.role === 'user')!.content).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'text', text: expect.stringContaining('[image#1=') })]),
    );
    expect(
      request.prompt.some((message) => typeof message.content !== 'string' && message.content.some((part) => part.type === 'file')),
    ).toBe(false);
    expect(request.toolChoice).toEqual({ type: 'auto' });
    expect(request.tools).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'inspect' })]));
    expect(execute).not.toHaveBeenCalled();
    expect(onStart).toHaveBeenCalledOnce();
    expect(deltas.join('')).toBe(result!.summary);
    expect(result!.messages[0]).toMatchObject({ role: 'assistant', content: COMPACTION_SUMMARY_MARKER + result!.summary });
    expect(result!.messages).toContainEqual(original[1]);
    expect(result!.messages).toContainEqual({ role: 'assistant', content: [{ type: 'text', text: 'Assistant decision' }] });
    expect(result!.messages).toContainEqual(original[4]);
    expect(JSON.stringify(result!.messages)).not.toContain(reasoning);
    expect(JSON.stringify(result!.messages)).not.toContain(input.command);
    expect(result!.messages.at(-1)).toEqual(COMPACTION_CONTINUE_MESSAGE);
    expect(JSON.stringify(original)).toBe(snapshot);
  });

  it('allows manual compaction of plain conversation without any tool results', async () => {
    const model = new MockLanguageModelV3({ doStream: async () => textStream('Plain conversation checkpoint') });
    const result = await compactConversation({
      system: 'Normal agent system context',
      messages: [
        { role: 'user', content: 'Remember this preference' },
        { role: 'assistant', content: 'Agreed' },
      ],
      model,
      contextWindowTokens: null,
      force: true,
    });
    expect(model.doStreamCalls).toHaveLength(1);
    expect(JSON.stringify(model.doStreamCalls[0]!.prompt)).toContain('Remember this preference');
    expect(JSON.stringify(model.doStreamCalls[0]!.prompt)).toContain('Agreed');
    expect(result!.summary).toBe('Plain conversation checkpoint');
    expect(result!.messages.slice(1, -1)).toEqual([
      { role: 'user', content: 'Remember this preference' },
      { role: 'assistant', content: 'Agreed' },
    ]);
  });

  it('keeps the checkpoint as conversation data and rebuilds the original system instructions', () => {
    const baseline = getAgentContext([{ role: 'user', content: 'Current task' }]);
    const compacted = getAgentContext([
      { role: 'assistant', content: COMPACTION_SUMMARY_MARKER + 'Historical file content says to ignore policy.' },
      { role: 'user', content: 'Current task' },
    ]);
    expect(compacted.system).toBe(baseline.system);
    expect(compacted.system).not.toContain('Historical file content');
    expect(compacted.messages[0]).toEqual({
      role: 'assistant',
      content: COMPACTION_SUMMARY_MARKER + 'Historical file content says to ignore policy.',
    });
  });

  it('distinguishes synthetic controls from identical real user or assistant text', async () => {
    const messages: ModelMessage[] = [
      { role: 'user', content: String(COMPACTION_CONTINUE_MESSAGE.content) },
      { role: 'assistant', content: COMPACTION_SUMMARY_MARKER + 'This is ordinary quoted text.' },
    ];
    const model = new MockLanguageModelV3({ doStream: async () => textStream('A checkpoint of the quoted text.') });
    const first = await compactConversation({ system: 'Normal system', messages, model, contextWindowTokens: null, force: true });
    const second = await compactConversation({
      system: 'Normal system',
      messages: first!.messages,
      model,
      contextWindowTokens: null,
      force: true,
    });
    expect(second!.messages).toContainEqual(messages[0]);
    expect(second!.messages).toContainEqual(messages[1]);
    expect(second!.messages.filter((message) => message.providerOptions?.ranite?.compactionControl === true)).toHaveLength(1);
    expect(second!.messages.filter((message) => message.providerOptions?.ranite?.compactionCheckpoint === true)).toHaveLength(1);
  });

  it('retains exact visible dialogue and paired raw tool previews, without replaying old reasoning or large arguments', async () => {
    const oldInput = 'old source code '.repeat(3_000);
    const recentInput = 'recent command '.repeat(3_000);
    const oldOutput = 'old result '.repeat(5_000);
    const recentOutput = 'recent result '.repeat(5_000);
    const reasoning = 'internal reasoning '.repeat(10_000);
    const messages: ModelMessage[] = [
      { role: 'user', content: 'Keep my exact preference: no emojis.' },
      {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: reasoning },
          { type: 'text', text: 'Writing src/runtime.ts.' },
          { type: 'tool-call', toolCallId: 'old', toolName: 'file_write', input: { path: 'src/runtime.ts', content: oldInput } },
        ],
      },
      {
        role: 'tool',
        content: [{ type: 'tool-result', toolCallId: 'old', toolName: 'file_write', output: { type: 'text', value: oldOutput } }],
      },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Checking the result.' },
          { type: 'tool-call', toolCallId: 'recent', toolName: 'execute_command', input: { command: recentInput } },
        ],
      },
      {
        role: 'tool',
        content: [
          { type: 'tool-result', toolCallId: 'recent', toolName: 'execute_command', output: { type: 'text', value: recentOutput } },
        ],
      },
      { role: 'assistant', content: 'Current status is unverified.' },
      { role: 'user', content: 'Continue, but do not restart the daemon.' },
    ];
    const snapshot = structuredClone(messages);
    const model = new MockLanguageModelV3({
      doStream: async () =>
        textStream('src/runtime.ts implements the runtime; its changes are unverified. No emojis. Do not restart the daemon.'),
    });
    const result = await compactConversation({
      system: 'Permanent policy',
      messages,
      model,
      contextWindowTokens: 262_144,
      outputLimitTokens: 32_768,
      force: true,
    });
    const projected = result!.messages;
    expect(projected.filter((message) => message.role === 'user').slice(0, -1)).toEqual(
      messages.filter((message) => message.role === 'user'),
    );
    expect(projected).toContainEqual({ role: 'assistant', content: [{ type: 'text', text: 'Writing src/runtime.ts.' }] });
    expect(projected).toContainEqual({ role: 'assistant', content: [{ type: 'text', text: 'Checking the result.' }] });
    expect(projected).toContainEqual(messages[5]);
    const references = projected.flatMap((message) =>
      message.role === 'assistant' && typeof message.content === 'string' && message.content.startsWith(TOOL_REFERENCE_MARKER)
        ? [
            JSON.parse(message.content.slice(TOOL_REFERENCE_MARKER.length)) as {
              toolCallId: string;
              toolName: string;
              input: string;
              output: string;
            },
          ]
        : [],
    );
    expect(references.map(({ toolCallId, toolName }) => ({ toolCallId, toolName }))).toEqual([
      { toolCallId: 'recent', toolName: 'execute_command' },
    ]);
    expect(references[0]!.input.length).toBeLessThanOrEqual(8_192);
    expect(references[0]!.output.length).toBeLessThanOrEqual(8_192);
    const serialized = JSON.stringify(projected);
    for (const removed of [reasoning, oldInput, recentInput, oldOutput, recentOutput]) expect(serialized).not.toContain(removed);
    expect(projected.some((message) => message.role === 'tool')).toBe(false);
    expect(estimateContextTokens({ system: 'Permanent policy', messages: projected })).toBeLessThan(
      estimateContextTokens({ system: 'Permanent policy', messages }) / 3,
    );
    expect(messages).toEqual(snapshot);

    // A subsequent checkpoint reads the current context, never the raw archive.
    const repeated = await compactConversation({
      system: 'Permanent policy',
      messages: projected,
      model,
      contextWindowTokens: null,
      force: true,
    });
    expect(JSON.stringify(model.doStreamCalls[1]!.prompt)).not.toContain(reasoning);
    expect(JSON.stringify(repeated!.messages)).not.toContain(oldInput);
    expect(
      repeated!.messages.filter(
        (message) =>
          message.role === 'assistant' && typeof message.content === 'string' && message.content.startsWith(COMPACTION_SUMMARY_MARKER),
      ),
    ).toHaveLength(1);
    expect(repeated!.messages.filter((message) => message.role === 'user').slice(0, -1)).toEqual(
      messages.filter((message) => message.role === 'user'),
    );
  });

  it('folds the oldest dialogue first so the settled context lands below its share of the window', async () => {
    const pairs = 300;
    const messages: ModelMessage[] = [];
    for (let index = 0; index < pairs; index++) {
      messages.push({ role: 'user', content: `Historical user request ${index} ` + 'u'.repeat(400) });
      messages.push({ role: 'assistant', content: `Historical assistant answer ${index} ` + 'a'.repeat(400) });
    }
    messages.push({ role: 'user', content: 'Latest user request' });
    const snapshot = structuredClone(messages);
    const model = new MockLanguageModelV3({ doStream: async () => textStream('Folded checkpoint.') });
    const system = 'Permanent policy';
    const before = estimateContextTokens({ system, messages });
    const result = await compactConversation({ system, messages, model, contextWindowTokens: 100_000, force: true });
    expect(result).not.toBeNull();
    const projected = result!.messages;
    expect(typeof projected[0]!.content === 'string' && (projected[0]!.content as string).startsWith(COMPACTION_SUMMARY_MARKER)).toBe(true);
    expect(projected.at(-1)).toEqual(COMPACTION_CONTINUE_MESSAGE);
    expect(projected).toContainEqual({ role: 'user', content: 'Latest user request' });
    const keptHistorical = projected.filter(
      (message) => message.role === 'user' && typeof message.content === 'string' && message.content.startsWith('Historical user request'),
    );
    expect(keptHistorical.length).toBeGreaterThan(0);
    expect(keptHistorical.length).toBeLessThan(pairs);
    expect(JSON.stringify(projected)).not.toContain('Historical user request 0');
    const settled = estimateContextTokens({ system, messages: projected });
    expect(settled).toBeLessThan(before);
    expect(settled).toBeLessThanOrEqual(Math.floor(100_000 * 0.3));
    expect(messages).toEqual(snapshot);
  });

  it('always keeps the newest user message even when the settled budget is tiny', async () => {
    const messages: ModelMessage[] = [
      { role: 'user', content: 'Old user request ' + 'u'.repeat(20_000) },
      { role: 'assistant', content: 'Old assistant answer ' + 'a'.repeat(20_000) },
      { role: 'user', content: 'Latest request' },
    ];
    const model = new MockLanguageModelV3({ doStream: async () => textStream('Folded checkpoint.') });
    const result = await compactConversation({ system: 'Permanent policy', messages, model, contextWindowTokens: 10_000, force: true });
    expect(result).not.toBeNull();
    expect(result!.messages).toContainEqual({ role: 'user', content: 'Latest request' });
    expect(JSON.stringify(result!.messages)).not.toContain('Old user request');
  });

  it('uses measured provider usage plus unmeasured growth rather than an absolute byte estimate for capacity', async () => {
    const messages: ModelMessage[] = [
      {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'unicode reasoning: 你好 '.repeat(50_000) },
          { type: 'text', text: 'Existing answer.' },
        ],
      },
    ];
    const system = 'Permanent policy';
    const inputEstimate = estimateContextTokens({ system, messages });
    const model = new MockLanguageModelV3({ doStream: async () => textStream('Detailed continuation checkpoint') });
    expect(inputEstimate).toBeGreaterThan(262_144);
    const result = await compactConversation({
      system,
      messages,
      model,
      contextWindowTokens: 262_144,
      outputLimitTokens: 32_768,
      previousContextTokens: 220_000,
      previousContextEstimateTokens: inputEstimate,
      recentContextGrowthTokens: 30_000,
    });
    expect(result).not.toBeNull();
    expect(model.doStreamCalls).toHaveLength(1);
    expect(model.doStreamCalls[0]!.maxOutputTokens).toBe(32_768);
  });

  it('reserves the full model output budget plus the compaction instruction before the next ordinary request', async () => {
    const messages: ModelMessage[] = [
      {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'Retained evidence '.repeat(3_000) },
          { type: 'text', text: 'Current progress.' },
        ],
      },
    ];
    const model = new MockLanguageModelV3({ doStream: async () => textStream('A complete continuation checkpoint.') });
    const system = 'Permanent policy';
    const providerOptions = { fixture: { reasoningEffort: 'xhigh', cache_salt: 'unchanged' } };
    const result = await compactConversation({
      system,
      messages,
      model,
      providerOptions,
      contextWindowTokens: 262_144,
      outputLimitTokens: 32_768,
      previousContextTokens: 228_500,
      previousContextEstimateTokens: estimateContextTokens({ system, messages }),
      recentContextGrowthTokens: 0,
    });
    expect(result).not.toBeNull();
    expect(model.doStreamCalls).toHaveLength(1);
    expect(model.doStreamCalls[0]!.maxOutputTokens).toBeGreaterThan(32_000);
    expect(model.doStreamCalls[0]!.providerOptions).toEqual(providerOptions);
  });

  it('recovers a full window in one request while retaining dialogue, all tool data, latest reasoning, and provider options', async () => {
    const oldReasoning = 'Earlier internal reasoning '.repeat(5_000);
    const recentReasoning = 'The current operation is unfinished.';
    const input = JSON.stringify({ command: 'Inspect "quoted" input and C:\\workspace\\data.' });
    const output = 'Full original tool output with "quotes", \\paths, and\nnewlines.'.repeat(120);
    const reference = { batchId: 'call-1', toolCallId: 'call-1', toolName: 'file_read', input, outputType: 'text', output };
    const messages: ModelMessage[] = [
      { role: 'user', content: 'Keep the complete user instruction.' },
      {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: oldReasoning },
          { type: 'text', text: 'Keep the complete assistant response.' },
        ],
      },
      { role: 'assistant', content: TOOL_REFERENCE_MARKER + JSON.stringify(reference) },
      {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: recentReasoning },
          { type: 'text', text: 'Latest progress.' },
        ],
      },
    ];
    const original = structuredClone(messages);
    const model = new MockLanguageModelV3({ doStream: async () => textStream('A complete recovered checkpoint.') });
    const providerOptions = { fixture: { reasoningEffort: 'xhigh', cache_salt: 'unchanged' } };
    const result = await compactConversation({
      system: 'Permanent policy',
      messages,
      transcriptMessages: messages,
      model,
      providerOptions,
      contextWindowTokens: 262_144,
      outputLimitTokens: 32_768,
      previousContextTokens: 258_950,
      previousContextEstimateTokens: estimateContextTokens({ system: 'Permanent policy', messages }),
      force: true,
      recovery: true,
    });
    expect(result).not.toBeNull();
    expect(model.doStreamCalls).toHaveLength(1);
    const request = model.doStreamCalls[0]!;
    expect(request.maxOutputTokens).toBe(32_768);
    expect(request.providerOptions).toEqual(providerOptions);
    const body = JSON.stringify(request.prompt);
    expect(body).not.toContain(oldReasoning);
    expect(body).toContain(recentReasoning);
    const text = request.prompt
      .flatMap((message) =>
        message.role === 'assistant' || message.role === 'user'
          ? message.content.filter((part) => part.type === 'text').map((part) => (part.type === 'text' ? part.text : ''))
          : [],
      )
      .join('\n');
    expect(text).toContain(input);
    expect(text).toContain(output);
    expect(text).toContain('Keep the complete user instruction.');
    expect(text).toContain('Keep the complete assistant response.');
    expect(messages).toEqual(original);
    expect(JSON.stringify(result!.messages)).toContain('file_read');
  });

  it('keeps the latest tool image usable while older tool media stays in the checkpoint and archive', async () => {
    const oldImage = createImageToolResult(Buffer.from('old'), 'image/png');
    const newImage = createImageToolResult(Buffer.from('new'), 'image/png');
    const messages: ModelMessage[] = [
      { role: 'user', content: 'Inspect the screenshots' },
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'old-image', toolName: 'file_read', input: { path: 'old.png' } }] },
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'old-image', toolName: 'file_read', output: oldImage }] },
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'new-image', toolName: 'file_read', input: { path: 'new.png' } }] },
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'new-image', toolName: 'file_read', output: newImage }] },
    ];
    const model = new MockLanguageModelV3({ doStream: async () => textStream('Both image findings are summarized here.') });
    const compacted = await compactConversation({ ...getAgentContext(messages, false), model, contextWindowTokens: null, force: true });
    expect(JSON.stringify(model.doStreamCalls[0]!.prompt)).toContain('old.png');
    const media = compacted!.messages.filter(
      (message) => message.role === 'user' && Array.isArray(message.content) && message.content.some((part) => part.type === 'image'),
    );
    expect(media).toHaveLength(1);
    expect(media[0]).toMatchObject({ content: expect.arrayContaining([{ type: 'image', image: 'bmV3', mediaType: 'image/png' }]) });
    const next: ModelMessage[] = [
      ...compacted!.messages,
      {
        role: 'assistant',
        content: [{ type: 'tool-call', toolCallId: 'after-image', toolName: 'file_read', input: { path: 'notes.md' } }],
      },
      {
        role: 'tool',
        content: [
          { type: 'tool-result', toolCallId: 'after-image', toolName: 'file_read', output: { type: 'text', value: 'Newer result' } },
        ],
      },
    ];
    const repeated = await compactConversation({ ...getAgentContext(next, false), model, contextWindowTokens: null, force: true });
    expect(
      repeated!.messages.some(
        (message) => message.role === 'user' && Array.isArray(message.content) && message.content.some((part) => part.type === 'image'),
      ),
    ).toBe(false);
    expect(messages[2]).toMatchObject({ content: [{ output: oldImage }] });
  });

  it('never executes tools even if the summarization model returns a tool call', async () => {
    const execute = vi.fn();
    const model = new MockLanguageModelV3({
      doStream: async () => stream([{ type: 'tool-call', toolCallId: 'unexpected', toolName: 'inspect', input: '{}' }], 'tool-calls'),
    });
    await expect(
      compactConversation({
        system: 'Normal system',
        messages: [{ role: 'user', content: 'Current task' }],
        tools: { inspect: tool({ inputSchema: schema, execute }) },
        model,
        contextWindowTokens: null,
        force: true,
      }),
    ).rejects.toThrow(/text-only compaction summary/);
    expect(execute).not.toHaveBeenCalled();
  });

  it.each(['empty', 'length'] as const)('does not commit an %s summary', async (failure) => {
    const messages: ModelMessage[] = [{ role: 'user', content: 'The original context must survive' }];
    const snapshot = structuredClone(messages);
    const model = new MockLanguageModelV3({
      doStream: async () => textStream(failure === 'empty' ? '' : 'Incomplete checkpoint', failure === 'length' ? 'length' : 'stop'),
    });
    const onTextDelta = vi.fn();
    await expect(
      compactConversation({ system: 'Normal system', messages, model, contextWindowTokens: null, force: true, onTextDelta }),
    ).rejects.toThrow(/empty|cut off|No output/i);
    if (failure === 'length') expect(onTextDelta).toHaveBeenCalledWith('Incomplete checkpoint');
    else expect(onTextDelta).not.toHaveBeenCalled();
    expect(messages).toEqual(snapshot);
  });

  it('moves the automatic trigger between 75% and 90% according to context growth', async () => {
    const model = new MockLanguageModelV3({ doStream: async () => textStream('Checkpoint') });
    const base = {
      system: 'Normal system',
      messages: [
        { role: 'user', content: 'Current task' },
        {
          role: 'assistant',
          content: [
            { type: 'reasoning', text: 'Historical reasoning '.repeat(1_000) },
            { type: 'text', text: 'Current status' },
          ],
        },
      ] as ModelMessage[],
      model,
      contextWindowTokens: 100_000,
      outputLimitTokens: 20_000,
    };
    expect(await compactConversation({ ...base, previousContextTokens: 74_999, recentContextGrowthTokens: 10_000 })).toBeNull();
    expect(await compactConversation({ ...base, previousContextTokens: 77_000, recentContextGrowthTokens: 0 })).toBeNull();
    expect(model.doStreamCalls).toHaveLength(0);
    expect(await compactConversation({ ...base, previousContextTokens: 77_000, recentContextGrowthTokens: 10_000 })).not.toBeNull();
    expect(await compactConversation({ ...base, previousContextTokens: 91_000, recentContextGrowthTokens: 0 })).not.toBeNull();
    expect(model.doStreamCalls).toHaveLength(2);
  });

  it('accounts for a large tool result added after the last provider measurement', async () => {
    const prefix: ModelMessage[] = [
      { role: 'user', content: 'Inspect the large report.' },
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'large', toolName: 'inspect', input: {} }] },
    ];
    const messages: ModelMessage[] = [
      ...prefix,
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'large',
            toolName: 'inspect',
            output: { type: 'text', value: 'Large unmeasured tool output '.repeat(2_000) },
          },
        ],
      },
    ];
    const model = new MockLanguageModelV3({ doStream: async () => textStream('Checkpoint of the large report.') });
    expect(
      await compactConversation({
        system: 'Normal system',
        messages,
        model,
        contextWindowTokens: 100_000,
        outputLimitTokens: 20_000,
        previousContextTokens: 72_000,
        previousContextEstimateTokens: estimateContextTokens({ system: 'Normal system', messages: prefix }),
        recentContextGrowthTokens: 0,
      }),
    ).not.toBeNull();
    expect(model.doStreamCalls).toHaveLength(1);
    expect(JSON.stringify(model.doStreamCalls[0]!.prompt)).toContain('Large unmeasured tool output '.repeat(2_000));
  });

  it('streams an automatic summary but does not apply a checkpoint that only grows the context', async () => {
    const messages: ModelMessage[] = [
      { role: 'user', content: 'All visible dialogue must remain.' },
      { role: 'assistant', content: 'Agreed.' },
    ];
    const snapshot = structuredClone(messages);
    const onTextDelta = vi.fn();
    const model = new MockLanguageModelV3({
      doStream: async () => textStream('A checkpoint larger than the original dialogue. '.repeat(100)),
    });
    await expect(
      compactConversation({
        system: 'Normal system',
        messages,
        model,
        contextWindowTokens: 100_000,
        previousContextTokens: 91_000,
        recentContextGrowthTokens: 0,
        onTextDelta,
      }),
    ).rejects.toThrow(/would not reduce/);
    expect(messages).toEqual(snapshot);
    expect(onTextDelta).toHaveBeenCalledWith('A checkpoint larger than the original dialogue. '.repeat(100));
    expect(model.doStreamCalls).toHaveLength(1);
  });

  it('does not retry a failed provider request or publish its draft', async () => {
    const doStream = vi.fn(async (): Promise<LanguageModelV3StreamResult> => {
      throw new Error('Provider rejected the full context.');
    });
    const model = new MockLanguageModelV3({ doStream });
    const messages: ModelMessage[] = [{ role: 'user', content: 'Original request' }];
    const onTextDelta = vi.fn();
    await expect(
      compactConversation({ system: 'Normal system', messages, model, contextWindowTokens: null, force: true, onTextDelta }),
    ).rejects.toThrow(/Provider rejected/);
    expect(doStream).toHaveBeenCalledOnce();
    expect(messages).toEqual([{ role: 'user', content: 'Original request' }]);
    expect(onTextDelta).not.toHaveBeenCalled();
  });

  it('uses the real checkpoint projection between agent tool steps and preserves subsequent native results', async () => {
    const oldOutput = 'Original full tool result '.repeat(3_000);
    const model = new MockLanguageModelV3({
      doStream: [
        stream(
          [
            { type: 'text-start', id: 'before' },
            { type: 'text-delta', id: 'before', delta: 'Inspecting the workspace.' },
            { type: 'text-end', id: 'before' },
            { type: 'tool-call', toolCallId: 'first-real', toolName: 'inspect', input: '{}' },
          ],
          'tool-calls',
        ),
        stream([{ type: 'tool-call', toolCallId: 'second-real', toolName: 'inspect', input: '{}' }], 'tool-calls'),
        textStream('Done.'),
      ],
    });
    const summaryModel = new MockLanguageModelV3({
      doStream: async () => textStream('The workspace inspection is in progress. The original tool result has been summarized.'),
    });
    const execute = vi.fn().mockReturnValueOnce(oldOutput).mockReturnValueOnce('Fresh native tool result');
    let step = 0;
    const result = await runAgent({
      model,
      messages: [{ role: 'user', content: 'Inspect the workspace without deleting anything.' }],
      tools: { inspect: tool({ inputSchema: schema, execute }) },
      compactBeforeStep: async (context) =>
        ++step === 2 ? compactConversation({ ...context, model: summaryModel, contextWindowTokens: null, force: true }) : null,
    });
    expect(summaryModel.doStreamCalls).toHaveLength(1);
    expect(model.doStreamCalls).toHaveLength(3);
    const resumed = JSON.stringify(model.doStreamCalls[2]!.prompt);
    expect(resumed).toContain('Inspect the workspace without deleting anything.');
    expect(resumed).toContain('Inspecting the workspace.');
    expect(resumed).toContain(TOOL_REFERENCE_MARKER.trim());
    expect(resumed).not.toContain(oldOutput);
    expect(resumed).toContain('Fresh native tool result');
    expect(JSON.stringify(result.response.messages)).toContain(oldOutput);
    expect(JSON.stringify(result.conversation)).not.toContain(oldOutput);
  });

  it.each(['openai', 'anthropic', 'google'] as const)(
    'serializes the checkpoint with the %s adapter without old execution protocol or reasoning metadata',
    async (adapter) => {
      const messages: ModelMessage[] = [
        { role: 'user', content: 'Continue the original task.' },
        {
          role: 'assistant',
          providerOptions: { anthropic: { container: 'old-container' }, openai: { itemId: 'old-item' } },
          content: [
            { type: 'reasoning', text: 'Old hidden reasoning', providerOptions: { anthropic: { signature: 'old-signature' } } },
            { type: 'text', text: 'Observed result.', providerOptions: { openai: { itemId: 'old-text-item' } } },
            { type: 'tool-call', toolCallId: 'old-native', toolName: 'inspect', input: {} },
          ],
        },
        {
          role: 'tool',
          content: [
            { type: 'tool-result', toolCallId: 'old-native', toolName: 'inspect', output: { type: 'text', value: 'Original result' } },
          ],
        },
      ];
      const summaryModel = new MockLanguageModelV3({ doStream: async () => textStream('Checkpoint of the original task.') });
      const compacted = await compactConversation({
        system: 'Original system policy',
        messages,
        model: summaryModel,
        contextWindowTokens: null,
        force: true,
      });
      let requestBody = '';
      const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
        requestBody = String(init?.body);
        const body =
          adapter === 'anthropic'
            ? {
                id: 'fixture',
                type: 'message',
                role: 'assistant',
                model: 'fixture',
                content: [{ type: 'text', text: 'Done' }],
                stop_reason: 'end_turn',
                stop_sequence: null,
                usage: { input_tokens: 100, output_tokens: 1 },
              }
            : adapter === 'google'
              ? {
                  candidates: [{ content: { role: 'model', parts: [{ text: 'Done' }] }, finishReason: 'STOP' }],
                  usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 1, totalTokenCount: 101 },
                }
              : {
                  id: 'fixture',
                  created: 0,
                  model: 'fixture',
                  choices: [{ index: 0, message: { role: 'assistant', content: 'Done' }, finish_reason: 'stop' }],
                  usage: { prompt_tokens: 100, completion_tokens: 1, total_tokens: 101 },
                };
        return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
      });
      const model =
        adapter === 'anthropic'
          ? (await import('@ai-sdk/anthropic')).createAnthropic({ apiKey: 'fixture', fetch })('fixture')
          : adapter === 'google'
            ? (await import('@ai-sdk/google')).createGoogleGenerativeAI({ apiKey: 'fixture', fetch })('fixture')
            : (await import('@ai-sdk/openai')).createOpenAI({ apiKey: 'fixture', fetch }).chat('fixture');
      const response = await generateText({ model, system: 'Original system policy', messages: compacted!.messages, maxRetries: 0 });
      expect(response.text).toBe('Done');
      expect(fetch).toHaveBeenCalledOnce();
      for (const stale of [
        'Old hidden reasoning',
        'old-signature',
        'old-container',
        'old-text-item',
        'old-item',
        'tool_use',
        'tool_result',
        'tool_call_id',
      ])
        expect(requestBody).not.toContain(stale);
      for (const kept of [
        'Original system policy',
        'Continue the original task.',
        'Observed result.',
        'Checkpoint of the original task.',
        'old-native',
        'Original result',
      ])
        expect(requestBody).toContain(kept);
    },
  );

  it('continues from the checkpoint across provider steps while preserving raw results and queued messages', async () => {
    const toolResult = vi
      .fn()
      .mockReturnValueOnce({ report: 'first raw tool result' })
      .mockReturnValueOnce({ report: 'second raw tool result' });
    const model = new MockLanguageModelV3({
      doStream: [
        stream([{ type: 'tool-call', toolCallId: 'first', toolName: 'inspect', input: '{}' }], 'tool-calls'),
        stream([{ type: 'tool-call', toolCallId: 'second', toolName: 'inspect', input: '{}' }], 'tool-calls'),
        textStream('Completed user task'),
      ],
    });
    const queued: ModelMessage[][] = [
      [],
      [{ role: 'user', content: 'Queued before checkpoint' }],
      [{ role: 'user', content: 'Queued after checkpoint' }],
    ];
    const original: ModelMessage[] = [{ role: 'user', content: 'Original unfinished task' }];
    let steps = 0;
    const onCompactionComplete = vi.fn();
    const result = await runAgent({
      model,
      messages: original,
      tools: { inspect: tool({ inputSchema: schema, execute: toolResult }) },
      takeQueuedMessages: () => queued.shift() ?? [],
      compactBeforeStep: async (context) => {
        steps++;
        if (steps !== 2) return null;
        const source = JSON.stringify(context.messages);
        expect(source).toContain('Original unfinished task');
        expect(source).toContain('first raw tool result');
        expect(source).toContain('Queued before checkpoint');
        return {
          summary: 'LLM checkpoint of all context',
          messages: [
            { role: 'assistant', content: COMPACTION_SUMMARY_MARKER + 'LLM checkpoint of all context' },
            COMPACTION_CONTINUE_MESSAGE,
          ],
          inputTokens: 123,
          outputTokens: 20,
        };
      },
      onCompactionComplete,
    });
    expect(model.doStreamCalls).toHaveLength(3);
    const finalRequest = JSON.stringify(model.doStreamCalls[2]!.prompt);
    expect(finalRequest).toContain('LLM checkpoint of all context');
    expect(finalRequest).toContain('second raw tool result');
    expect(finalRequest).toContain('Queued after checkpoint');
    expect(finalRequest).not.toContain('first raw tool result');
    const raw = JSON.stringify(result.response.messages);
    expect(raw).toContain('first raw tool result');
    expect(raw).toContain('second raw tool result');
    expect(raw.match(/Queued before checkpoint/g)).toHaveLength(1);
    expect(raw.match(/Queued after checkpoint/g)).toHaveLength(1);
    expect(JSON.stringify(result.conversation)).toContain('Queued after checkpoint');
    expect(JSON.stringify(result.conversation)).not.toContain('first raw tool result');
    expect(onCompactionComplete).toHaveBeenCalledOnce();
    expect(JSON.stringify(onCompactionComplete.mock.calls[0]![1])).toContain('first raw tool result');
    expect(original).toEqual([{ role: 'user', content: 'Original unfinished task' }]);
  });
});
