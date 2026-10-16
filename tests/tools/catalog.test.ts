import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MemoryIndex } from '../../src/memory-index.js';
import { createToolCatalogue } from '../../src/tools/catalog.js';
import type { McpConnectionManager } from '../../src/tools/mcp.js';

const mcpStub: McpConnectionManager = {
  tools: [],
  list: () => [],
  addServer: async () => [],
  connectServer: async () => ({ connected: false, changed: false, tools: [] }),
  disconnectServer: async () => false,
  removeServer: async () => false,
  close: async () => {},
};

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
  'read_owner_messages',
  'team_send',
  'team_inbox',
  'team_group',
  'team_status',
  'team_remember',
  'session_message',
  'subagent',
  'parent_message',
  'subagent_poll',
  'subagent_stop',
  'mcp_manage',
  'background_manage',
];

describe('tool catalogue', () => {
  it('offers every host tool to every session, even with no host handlers', () => {
    const names = catalogueNames();
    for (const name of ALWAYS_OFFERED) expect(names).toContain(name);
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
    const result = (await built.tools.background_manage!.execute!({ action: 'list' }, { toolCallId: 'call-1', messages: [] })) as {
      status: unknown;
    };
    expect(result.status).toBe('unavailable');
  });
});
