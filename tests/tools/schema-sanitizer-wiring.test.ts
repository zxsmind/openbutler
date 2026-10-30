import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { MemoryIndex } from '../../src/memory-index.js';
import { createToolCatalogue } from '../../src/tools/catalog.js';
import { ToolRegistry } from '../../src/tools/registry.js';
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

it("rebuilds every tool schema through the run's sanitizer when one is given", async () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'openbutler-sanitizer-'));
  const memoryIndex = new MemoryIndex(workspaceRoot);
  try {
    const registry = new ToolRegistry();
    const catalogue = createToolCatalogue({
      workspaceRoot,
      inputModalities: [],
      memoryIndex,
      mcp: mcpStub,
      onMcpConnectionsChanged() {},
    });
    for (const definition of catalogue) registry.register(definition);

    const seen: unknown[] = [];
    const built = await registry.createModelTools({
      approve: async () => true,
      onResult: () => {},
      schemaSanitizer: (schema) => {
        seen.push(schema);
        return schema;
      },
    });

    expect(seen.length).toBe(catalogue.length);
    expect(seen).toContain(catalogue.find((definition) => definition.name === 'send_message_to_owner')?.inputSchema);
    expect(Object.keys(built.tools).length).toBe(catalogue.length);
  } finally {
    await memoryIndex.close();
  }
});
