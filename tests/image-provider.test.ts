import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateText, type ModelMessage } from 'ai';
import { createGateway } from '@ai-sdk/gateway';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getAgentContext } from '../src/agent.js';
import { createReadTool } from '../src/tools/file-read.js';

const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6C9sAAAAASUVORK5CYII=';
let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ranite-image-provider-'));
  vi.stubEnv('RANITE_DATA_DIR', root);
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

async function wireImages(messages: ModelMessage[]): Promise<unknown[]> {
  const payloads: unknown[] = [];
  const gateway = createGateway({
    apiKey: 'fixture',
    fetch: async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { prompt: Array<{ content: Array<{ type: string; data?: unknown }> }> };
      payloads.push(...body.prompt.flatMap((message) => message.content.filter((part) => part.type === 'file').map((part) => part.data)));
      return new Response(
        JSON.stringify({
          content: [{ type: 'text', text: 'Done.' }],
          finishReason: { unified: 'stop', raw: 'stop' },
          usage: {
            inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: 2, text: 2, reasoning: 0 },
          },
          warnings: [],
        }),
        { headers: { 'content-type': 'application/json' } },
      );
    },
  });
  await generateText({ model: gateway('fixture/image-model'), messages, maxRetries: 0 });
  return payloads;
}

describe('on-demand visual attachments across provider requests', () => {
  it.each(['padded', 'unpadded', 'wrapped', 'data-url', 'binary'])(
    'keeps %s input out of the model until file_read explicitly opens its stored file',
    async (variant) => {
      const data =
        variant === 'unpadded'
          ? PNG.replace(/=+$/, '')
          : variant === 'wrapped'
            ? PNG.replace(/(.{8})/g, '$1\n')
            : variant === 'data-url'
              ? `data:image/png;base64,${PNG}`
              : variant === 'binary'
                ? Buffer.from(PNG, 'base64')
                : PNG;
      const incoming: ModelMessage[] = [
        {
          role: 'user',
          content: [
            { type: 'text', text: '[image#1] What is this?' },
            { type: 'image', image: data, mediaType: 'image/png' },
          ],
        },
      ];
      const before = JSON.stringify(incoming);
      const context = getAgentContext(incoming, false, root, undefined, true, undefined, SESSION_ID);
      expect(await wireImages(context.messages)).toEqual([]);
      const text = JSON.stringify(context.messages);
      expect(text).toContain('image#1');
      expect(text).not.toContain(PNG);
      const reference = context.messages[0]!;
      if (reference.role !== 'user' || !Array.isArray(reference.content)) throw new Error('Missing user reference');
      const mapping = reference.content.find((part) => part.type === 'text' && part.text.startsWith('[image#1='));
      if (!mapping || mapping.type !== 'text') throw new Error('Missing image mapping');
      const path = JSON.parse(mapping.text.slice('[image#1='.length, -1)) as string;
      expect(readFileSync(path)).toEqual(Buffer.from(PNG, 'base64'));
      const reader = createReadTool(['image'], root);
      const opened = await reader.execute({ path });
      const messages: ModelMessage[] = [
        ...incoming,
        { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'open', toolName: 'file_read', input: { path } }] },
        {
          role: 'tool',
          content: [{ type: 'tool-result', toolCallId: 'open', toolName: 'file_read', output: await reader.toModelOutput!(opened) }],
        },
      ];
      expect(await wireImages(getAgentContext(messages, false, root, undefined, true, undefined, SESSION_ID).messages)).toEqual([
        `data:image/png;base64,${PNG}`,
      ]);
      expect(JSON.stringify(incoming)).toBe(before);
      expect(context.transcriptMessages).toBe(incoming);
    },
  );

  it('keeps references on non-vision models and never downloads a remote image implicitly', async () => {
    const messages: ModelMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'image', image: PNG, mediaType: 'image/png' },
          { type: 'image', image: 'https://example.com/second.png', mediaType: 'image/png' },
        ],
      },
    ];
    const context = getAgentContext(messages, false, root, undefined, false, undefined, SESSION_ID);
    expect(await wireImages(context.messages)).toEqual([]);
    expect(JSON.stringify(context.messages)).toContain('image#2');
    expect(JSON.stringify(context.messages)).toContain('https://example.com/second.png');
    expect(JSON.stringify(context.messages)).not.toContain('omitted');
  });
});
