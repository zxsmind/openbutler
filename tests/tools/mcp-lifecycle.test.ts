import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { basename, dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { McpConnectionManager } from '../../src/tools/mcp.js';

let root: string;
let manager: McpConnectionManager | undefined;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'openbutler-mcp-wire-'));
  vi.stubEnv('OPENBUTLER_DATA_DIR', root);
  vi.stubEnv('OPENBUTLER_MCP_FIXTURE_SECRET', 'private-fixture-value');
  vi.resetModules();
});
afterEach(async () => {
  await manager?.close();
  manager = undefined;
  vi.unstubAllEnvs();
  if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith('openbutler-mcp-wire-'))
    throw new Error('Unsafe fixture path.');
  rmSync(root, { recursive: true, force: true });
});

// A real local stdio server: no SDK mock, network, credentials, or model requests.
const serverScript = `
const readline = require('node:readline');
readline.createInterface({input: process.stdin}).on('line', line => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  let result;
  if (request.method === 'initialize') result = {
    protocolVersion: request.params.protocolVersion, capabilities: {tools: {}}, serverInfo: {name: 'fixture', version: '1'}
  };
  else if (request.method === 'tools/list') result = {tools: [
    {name: 'ping', description: 'Fixture ping', inputSchema: {type: 'object', properties: {exit: {type: 'boolean'}}}}
  ]};
  else if (request.method === 'tools/call') {
    if (request.params.arguments.exit) {
      process.stderr.write('Fixture failure: ' + process.env.MCP_SECRET + '\\n', () => process.exit(1));
      return;
    }
    result = {content: [{type: 'text', text: String(process.pid)}]};
  }
  else result = {};
  process.stdout.write(JSON.stringify({jsonrpc: '2.0', id: request.id, result}) + '\\n');
});
`;

it('shares a real stdio transport, detects its exit, reconnects and redacts startup output', async () => {
  const settings = await import('../../src/settings.js');
  expect(settings.getSettingsPath()).toBe(join(root, 'settings.yaml'));
  const store = settings.defaultSettings();
  store.mcpServers.fixture = {
    transport: 'stdio',
    command: process.execPath,
    args: ['-e', serverScript],
    env: { MCP_SECRET: 'OPENBUTLER_MCP_FIXTURE_SECRET' },
  };
  settings.saveSettings(store);
  const { createMcpConnectionManager } = await import('../../src/tools/mcp.js');
  const errors = vi.fn();
  const connected = vi.fn();
  manager = createMcpConnectionManager({ onError: errors, onConnected: connected });
  await Promise.all([manager.reload(store.mcpServers), manager.connectServer('fixture'), manager.reload(store.mcpServers)]);
  expect(connected).toHaveBeenCalledOnce();
  const tool = manager.tools[0]!;
  const first = (await tool.execute({})) as { content: Array<{ text: string }> };
  expect(Number(first.content[0]!.text)).toBeGreaterThan(0);
  await expect(tool.execute({ exit: true })).rejects.toThrow();
  await vi.waitFor(() => expect(manager!.list()[0]).toMatchObject({ connected: false, state: 'retrying' }));
  const diagnostics = JSON.stringify([manager.list(), errors.mock.calls]);
  expect(diagnostics).toContain('Fixture failure');
  expect(diagnostics).toContain('[redacted]');
  expect(diagnostics).not.toContain('private-fixture-value');
  await manager.connectServer('fixture');
  const second = (await tool.execute({})) as { content: Array<{ text: string }> };
  expect(second.content[0]!.text).not.toBe(first.content[0]!.text);
  expect(connected).toHaveBeenCalledTimes(2);
  await manager.close();
  await expect(tool.execute({})).rejects.toThrow('disconnected');
}, 10000);

it('recovers an expired real HTTP MCP session without replaying its failed request', async () => {
  let session = 0;
  let expired = false;
  let calls = 0;
  const endpoint = createServer(async (request, response) => {
    if (request.method !== 'POST') {
      response.writeHead(405).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const message = JSON.parse(Buffer.concat(chunks).toString());
    if (message.id === undefined) {
      response.writeHead(202).end();
      return;
    }
    if (message.method === 'tools/call') {
      calls++;
      if (expired) {
        response.writeHead(404).end('Session expired');
        return;
      }
    }
    let result: unknown = {};
    if (message.method === 'initialize') {
      session++;
      result = {
        protocolVersion: message.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: 'fixture', version: '1' },
      };
    } else if (message.method === 'tools/list') {
      result = { tools: [{ name: 'ping', description: 'Fixture ping', inputSchema: { type: 'object' } }] };
    } else if (message.method === 'tools/call') {
      result = { content: [{ type: 'text', text: String(session) }] };
    }
    response.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': String(session) });
    response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
  });
  await new Promise<void>((done) => endpoint.listen(0, '127.0.0.1', done));
  try {
    const address = endpoint.address() as { port: number };
    const settings = await import('../../src/settings.js');
    expect(settings.getSettingsPath()).toBe(join(root, 'settings.yaml'));
    const store = settings.defaultSettings();
    store.mcpServers.fixture = { transport: 'http', url: `http://127.0.0.1:${address.port}/mcp`, headers: {} };
    settings.saveSettings(store);
    const { connectMcpServers } = await import('../../src/tools/mcp.js');
    manager = await connectMcpServers(store.mcpServers, { onError: vi.fn(), onConnected: vi.fn() });
    const tool = manager.tools[0]!;
    expect(await tool.execute({})).toMatchObject({ content: [{ text: '1' }] });
    expired = true;
    await expect(tool.execute({})).rejects.toThrow();
    expect(manager.list()[0]).toMatchObject({ connected: false, state: 'retrying' });
    expect(calls).toBe(2);
    expired = false;
    await manager.connectServer('fixture');
    expect(calls).toBe(2);
    expect(await tool.execute({})).toMatchObject({ content: [{ text: '2' }] });
    expect(calls).toBe(3);
  } finally {
    await manager?.close();
    await new Promise<void>((done, reject) => endpoint.close((error) => (error ? reject(error) : done())));
  }
}, 10000);
