import { expect, it } from 'vitest';
import { ToolRegistry, type ToolCallRequest } from '../../src/tools/registry.js';

const effect = { change: 'none', data: 'local', network: 'none', reversible: 'full', outbound: 'model' } as const;

const AWS_SECRET = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYRANDOMKEY1';

it('redacts secrets from a tool result before the model, transcript, or ledger sees it', async () => {
  const registry = new ToolRegistry();
  registry.register({
    providerId: 'host',
    name: 'leaky',
    description: 'Fixture that returns credentials',
    inputSchema: { type: 'object', properties: {} },
    effect,
    execute: async () => ({
      status: 'completed',
      stdout: `AWS_SECRET_ACCESS_KEY=${AWS_SECRET}\nghp_${'a'.repeat(36)}\ndone`,
    }),
  });

  const modelResults: unknown[] = [];
  const ledgerResults: unknown[] = [];
  const built = await registry.createModelTools({
    approve: async () => true,
    onResult: (_request: ToolCallRequest, result: unknown) => modelResults.push(result),
    onAction: (_request, state, detail) => {
      if (state === 'completed') ledgerResults.push(detail?.result);
    },
  });

  const returned = await built.tools.leaky!.execute!({}, { toolCallId: 'call-1', messages: [] });
  for (const value of [returned, modelResults[0], ledgerResults[0]]) {
    const serialized = JSON.stringify(value);
    expect(serialized).not.toContain('RANDOMKEY1');
    expect(serialized).not.toContain('ghp_' + 'a'.repeat(36));
    expect(serialized).toContain('[redacted]');
  }
  expect((returned as { stdout: string }).stdout).toContain('AWS_SECRET_ACCESS_KEY=[redacted]');
});

it('keeps an image payload intact while redacting the text beside it', async () => {
  const registry = new ToolRegistry();
  const imageToken = 'ghp_' + 'a'.repeat(36);
  registry.register({
    providerId: 'host',
    name: 'media',
    description: 'Fixture that returns media',
    inputSchema: { type: 'object', properties: {} },
    effect,
    execute: async () => ({
      type: 'content',
      value: [
        { type: 'text', text: `token=${imageToken}` },
        { type: 'image-data', data: imageToken, mediaType: 'image/png' },
      ],
    }),
  });

  const built = await registry.createModelTools({ approve: async () => true, onResult: () => {} });
  const returned = (await built.tools.media!.execute!({}, { toolCallId: 'call-2', messages: [] })) as {
    value: Array<Record<string, unknown>>;
  };
  expect(returned.value[0]?.text).toBe('token=[redacted]');
  expect(returned.value[1]?.data).toBe(imageToken);
});

it('leaves an ordinary result untouched', async () => {
  const registry = new ToolRegistry();
  registry.register({
    providerId: 'host',
    name: 'plain',
    description: 'Fixture that returns nothing sensitive',
    inputSchema: { type: 'object', properties: {} },
    effect,
    execute: async () => ({ status: 'completed', stdout: 'all good\nbuild finished in 3.2s' }),
  });

  const built = await registry.createModelTools({ approve: async () => true, onResult: () => {} });
  const returned = await built.tools.plain!.execute!({}, { toolCallId: 'call-3', messages: [] });
  // The tool's own output is untouched; the run's timing rides beside it.
  expect(returned).toMatchObject({ status: 'completed', stdout: 'all good\nbuild finished in 3.2s' });
  expect(typeof (returned as Record<string, unknown>).raniteTiming).toBe('string');
});
