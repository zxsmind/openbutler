import { mkdtempSync, rmSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const client = vi.hoisted(() => ({ connect: vi.fn(), listTools: vi.fn(), callTool: vi.fn(), close: vi.fn() }));
vi.mock('@modelcontextprotocol/client', async (original) => ({
  ...(await original<typeof import('@modelcontextprotocol/client')>()),
  Client: class {
    connect = client.connect;
    listTools = client.listTools;
    callTool = client.callTool;
    close = client.close;
  },
}));
let root: string;
beforeEach(() => {
  vi.resetModules();
  root = mkdtempSync(join(tmpdir(), 'ranite-mcp-timeout-'));
  vi.stubEnv('RANITE_DATA_DIR', root);
  vi.useFakeTimers();
  client.connect.mockReset().mockResolvedValue(undefined);
  client.close.mockReset().mockResolvedValue(undefined);
  client.listTools.mockReset().mockResolvedValue({
    tools: [
      {
        name: 'wait',
        description: 'Fixture.',
        inputSchema: { type: 'object', properties: { value: { type: 'string' } }, additionalProperties: false },
      },
    ],
  });
  client.callTool.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith('ranite-mcp-timeout-'))
    throw new Error('Invalid fixture cleanup path.');
  rmSync(root, { recursive: true, force: true });
});

it('passes the selected budget to the MCP SDK and strips host metadata from server arguments', async () => {
  const { getSettingsPath, getConfigPath } = await import('../../src/settings.js');
  expect(getSettingsPath()).toBe(join(root, 'settings.yaml'));
  expect(getConfigPath()).toBe(join(root, 'config.yaml'));
  const { ToolRegistry } = await import('../../src/tools/registry.js');
  const { connectMcpServers } = await import('../../src/tools/mcp.js');
  const manager = await connectMcpServers(
    { fixture: { transport: 'http', url: 'https://fixture.invalid/mcp', headers: {} } },
    { onError: vi.fn(), onConnected: vi.fn() },
  );
  let started!: () => void;
  const entered = new Promise<void>((done) => {
    started = done;
  });
  let complete!: (value: unknown) => void;
  const pending = new Promise<unknown>((done) => {
    complete = done;
  });
  client.callTool.mockImplementation(() => {
    started();
    return pending;
  });
  const registry = new ToolRegistry();
  for (const tool of manager.tools) registry.register(tool);
  const built = await registry.createModelTools({ approve: async () => true, onResult: () => {} });
  const call = Object.values(built.tools)[0]!.execute!({ value: 'hello', _timeoutSeconds: 500 }, { toolCallId: 'mcp-long', messages: [] });
  await entered;
  const [request, options] = client.callTool.mock.calls[0]!;
  expect(request).toEqual({ name: 'wait', arguments: { value: 'hello' } });
  expect(options).toMatchObject({ timeout: 500_000, maxTotalTimeout: 500_000 });
  await vi.advanceTimersByTimeAsync(61_000);
  expect(options.requestSignal.aborted).toBe(false);
  complete({ content: [{ type: 'text', text: 'done' }] });
  expect(await call).toMatchObject({ content: [{ text: 'done' }] });
  await manager.close();
  expect(vi.getTimerCount()).toBe(0);
});

it('lets a selected connection budget replace the startup-only 15-second handshake limit', async () => {
  const { getSettingsPath, getConfigPath } = await import('../../src/settings.js');
  expect(getSettingsPath()).toBe(join(root, 'settings.yaml'));
  expect(getConfigPath()).toBe(join(root, 'config.yaml'));
  const { ToolRegistry } = await import('../../src/tools/registry.js');
  const { connectMcpServers, createMcpManagementTool } = await import('../../src/tools/mcp.js');
  const manager = await connectMcpServers({}, { onError: vi.fn(), onConnected: vi.fn() });
  let started!: () => void;
  const entered = new Promise<void>((done) => {
    started = done;
  });
  let complete!: () => void;
  const pending = new Promise<void>((done) => {
    complete = done;
  });
  client.connect.mockImplementation(() => {
    started();
    return pending;
  });
  const changed = vi.fn();
  const registry = new ToolRegistry();
  registry.register(createMcpManagementTool(manager, changed));
  const built = await registry.createModelTools({ approve: async () => true, onResult: () => {} });
  const call = built.tools.mcp_manage!.execute!(
    {
      action: 'add',
      serverId: 'fixture',
      config: { transport: 'http', url: 'https://fixture.invalid/mcp', headers: {} },
      _timeoutSeconds: 500,
    },
    { toolCallId: 'mcp-connect', messages: [] },
  );
  await entered;
  const options = client.connect.mock.calls[0]![1];
  expect(options).toMatchObject({ timeout: 500_000, maxTotalTimeout: 500_000 });
  await vi.advanceTimersByTimeAsync(61_000);
  expect(options.signal.aborted).toBe(false);
  complete();
  expect(await call).toMatchObject({ status: 'completed', changed: true });
  expect(changed).toHaveBeenCalledTimes(1);
  await manager.close();
  expect(vi.getTimerCount()).toBe(0);
});
