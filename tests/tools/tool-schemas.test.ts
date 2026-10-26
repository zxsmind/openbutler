import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { MemoryIndex } from '../../src/memory-index.js';
import { createToolCatalogue } from '../../src/tools/catalog.js';
import { createSendMessageToOwnerTool } from '../../src/tools/owner-communication.js';
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

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Google validates every function declaration against its own Schema subset before
 * inference, and the subset is stricter than JSON Schema: `required` is accepted only
 * on an OBJECT node that declares those names in its own `properties`, and a node
 * carrying a composition keyword may carry nothing else. One violating declaration
 * fails the whole request, so every built-in tool schema is held to the subset here;
 * third-party MCP schemas are normalized at the provider boundary instead
 * (src/provider/gemini-schema.ts).
 */
function subsetViolations(value: unknown, path: string): string[] {
  if (Array.isArray(value)) return value.flatMap((entry, index) => subsetViolations(entry, `${path}[${index}]`));
  if (!isRecord(value)) return [];
  const node = value;
  const violations: string[] = [];
  for (const keyword of ['anyOf', 'oneOf', 'allOf'] as const) {
    if (node[keyword] !== undefined) {
      violations.push(`${path}: declares ${keyword}, which Google rejects next to the sibling fields of a tool parameter`);
    }
  }
  if (Array.isArray(node.required)) {
    if (node.type !== 'object') violations.push(`${path}: required without type "object"`);
    if (isRecord(node.properties)) {
      for (const name of node.required) {
        if (typeof name === 'string' && !(name in node.properties))
          violations.push(`${path}: required "${name}" is not declared in properties`);
      }
    }
  }
  if (node.type !== undefined && node.type !== 'object' && node.properties !== undefined) {
    violations.push(`${path}: properties on non-object type ${String(node.type)}`);
  }
  if (isRecord(node.properties)) {
    for (const [name, child] of Object.entries(node.properties)) violations.push(...subsetViolations(child, `${path}.${name}`));
  }
  if (node.items !== undefined) violations.push(...subsetViolations(node.items, `${path}.items`));
  for (const keyword of ['anyOf', 'oneOf', 'allOf'] as const) {
    if (Array.isArray(node[keyword])) violations.push(...subsetViolations(node[keyword], `${path}.${keyword}`));
  }
  for (const key of ['$defs', 'definitions'] as const) {
    if (isRecord(node[key])) {
      for (const [name, child] of Object.entries(node[key])) violations.push(...subsetViolations(child, `${path}.${key}.${name}`));
    }
  }
  return violations;
}

it("holds every built-in tool schema to Google's function schema subset", async () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'ranite-schema-'));
  const memoryIndex = new MemoryIndex(workspaceRoot);
  try {
    const catalogue = createToolCatalogue({
      workspaceRoot,
      inputModalities: [],
      memoryIndex,
      mcp: mcpStub,
      onMcpConnectionsChanged() {},
    });
    const violations = catalogue.flatMap((definition) => subsetViolations(definition.inputSchema, definition.name));
    expect(violations).toEqual([]);
  } finally {
    await memoryIndex.close();
  }
});

describe('send_message_to_owner payload rule', () => {
  it('rejects a call with no payload field now that the schema carries no anyOf', async () => {
    const send = vi.fn(async () => ({ ok: true }));
    const tool = createSendMessageToOwnerTool('/workspace', send);

    expect(await tool.execute({})).toEqual({ error: 'Provide at least one of text, imagePath or filePath.' });
    expect(await tool.execute({ text: '   ', replyTo: ['event-1'] })).toEqual({
      error: 'Provide at least one of text, imagePath or filePath.',
    });
    expect(send).not.toHaveBeenCalled();

    await tool.execute({ text: 'hello' });
    await tool.execute({ filePath: 'C:\\tmp\\photo.png' });
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('states the rule in the description the model reads', () => {
    const tool = createSendMessageToOwnerTool('/workspace', async () => ({}));
    expect(tool.description).toContain('At least one of text, imagePath or filePath is required.');
    expect(tool.inputSchema).not.toHaveProperty('anyOf');
  });
});
