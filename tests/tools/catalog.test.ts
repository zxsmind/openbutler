import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { MemoryIndex } from '../../src/memory-index.js';
import { createToolCatalogue } from '../../src/tools/catalog.js';
import type { McpConnectionManager } from '../../src/tools/mcp.js';

const mcpStub: McpConnectionManager = {
  revision: 0,
  tools: [],
  list: () => [],
  addServer: async () => [],
  connectServer: async () => ({ connected: false, changed: false, tools: [] }),
  disconnectServer: async () => false,
  removeServer: async () => false,
  reload: async () => false,
  close: async () => {},
};

it('keeps each model input modality on its own call when MCP transports are shared', async () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'ranite-catalog-'));
  const memoryIndex = new MemoryIndex(workspaceRoot);
  const execute = vi.fn(async () => ({}));
  const shared: McpConnectionManager = {
    ...mcpStub,
    tools: [
      {
        providerId: 'mcp-fixture',
        name: 'fixture',
        description: 'Fixture',
        inputSchema: { type: 'object' },
        execute,
        effect: { change: 'none', data: 'public', network: 'none', reversible: 'full', outbound: 'none' },
      },
    ],
  };
  try {
    const catalogue = (inputModalities: string[]) =>
      createToolCatalogue({ workspaceRoot, inputModalities, memoryIndex, mcp: shared, onMcpConnectionsChanged() {} });
    const text = catalogue(['text']).find((tool) => tool.name === 'fixture')!;
    const vision = catalogue(['text', 'image']).find((tool) => tool.name === 'fixture')!;
    await text.execute({});
    await vision.execute({});
    expect(execute).toHaveBeenNthCalledWith(1, {}, undefined, { inputModalities: ['text'] });
    expect(execute).toHaveBeenNthCalledWith(2, {}, undefined, { inputModalities: ['text', 'image'] });
  } finally {
    await memoryIndex.close();
  }
});

function catalogueNames(options: Record<string, unknown> = {}): string[] {
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'ranite-catalog-'));
  return createToolCatalogue({
    workspaceRoot,
    inputModalities: [],
    memoryIndex: new MemoryIndex(workspaceRoot),
    mcp: mcpStub,
    onMcpConnectionsChanged: () => {},
    ...(options as object),
  }).map((definition) => definition.name);
}

const ALWAYS_OFFERED = [
  'execute_command',
  'file_read',
  'file_write',
  'file_edit',
  'glob',
  'grep',
  'question',
  'memory_search',
  'session_list',
  'session_search',
  'session_read',
  'send_message_to_owner',
  'inbox',
  'team_send',
  'team_group',
  'team_history',
  'team_status',
  'team_remember',
  'team_send_file',
  'team_receive_file',
  'team_files',
  'session_message',
  'subagent',
  'parent_message',
  'subagent_stop',
  'mcp_manage',
  'schedule',
];

describe('tool catalogue', () => {
  it('offers every host tool to every session, even with no host handlers', () => {
    const names = catalogueNames();
    for (const name of ALWAYS_OFFERED) expect(names).toContain(name);
    for (const retired of ['read_owner_messages', 'team_inbox', 'subagent_poll']) expect(names).not.toContain(retired);
  });

  it('answers unavailable instead of vanishing when a handler is absent', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'ranite-catalog-'));
    const { ToolRegistry } = await import('../../src/tools/registry.js');
    const registry = new ToolRegistry();
    const { createToolCatalogue: build } = await import('../../src/tools/catalog.js');
    for (const definition of build({
      workspaceRoot,
      inputModalities: [],
      memoryIndex: new MemoryIndex(workspaceRoot),
      mcp: mcpStub,
      onMcpConnectionsChanged: () => {},
    })) {
      registry.register(definition);
    }
    const built = await registry.createModelTools({ approve: async () => true, onResult: () => {} });
    const result = (await built.tools.schedule!.execute!({ action: 'list' }, { toolCallId: 'call-1', messages: [] })) as {
      status: unknown;
    };
    expect(result.status).toBe('unavailable');
  });
});
