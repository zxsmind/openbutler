import { expect, it } from 'vitest';
import { ToolRegistry } from '../../src/tools/registry.js';

const effect = { change: 'none', data: 'local', network: 'none', reversible: 'full', outbound: 'model' } as const;

it('resolves the target once and passes the same value to every policy hook and execute', async () => {
  const registry = new ToolRegistry();
  const seen: Array<[string, string | undefined]> = [];
  registry.register({
    providerId: 'host',
    name: 'bound',
    description: 'Fixture',
    inputSchema: { type: 'object', properties: {} },
    effect,
    resolveTarget: () => '/resolved/target',
    assess: (_input, target) => {
      seen.push(['assess', target]);
      return effect;
    },
    autoApprove: (_input, target) => {
      seen.push(['autoApprove', target]);
      return false;
    },
    workspaceScope: (_input, target) => {
      seen.push(['scope', target]);
      return 'workspace';
    },
    execute: async (_input, _signal, context) => {
      seen.push(['execute', context?.target]);
      return { status: 'completed' };
    },
  });
  const built = await registry.createModelTools({ approve: async () => true, approvalMode: 'workspace', onResult: () => {} });
  await built.tools.bound!.execute!({}, { toolCallId: 'call-1', messages: [] });
  expect(seen).toEqual([
    ['assess', '/resolved/target'],
    ['scope', '/resolved/target'],
    ['autoApprove', '/resolved/target'],
    ['execute', '/resolved/target'],
  ]);
});

it('keeps working without a target when resolution is unavailable or throws', async () => {
  const registry = new ToolRegistry();
  const seen: Array<string | undefined> = [];
  registry.register({
    providerId: 'host',
    name: 'unbound',
    description: 'Fixture',
    inputSchema: { type: 'object', properties: {} },
    effect,
    resolveTarget: () => {
      throw new Error('unresolvable');
    },
    workspaceScope: (_input, target) => {
      seen.push(target);
      return 'workspace';
    },
    execute: async (_input, _signal, context) => {
      seen.push(context?.target);
      return { status: 'completed' };
    },
  });
  const built = await registry.createModelTools({ approve: async () => true, approvalMode: 'workspace', onResult: () => {} });
  await built.tools.unbound!.execute!({}, { toolCallId: 'call-2', messages: [] });
  expect(seen).toEqual([undefined, undefined]);
});
