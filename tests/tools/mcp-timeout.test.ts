import { mkdtempSync, rmSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const client = vi.hoisted(() => ({
  connect: vi.fn(),
  listTools: vi.fn(),
  callTool: vi.fn(),
  close: vi.fn(),
  instances: [] as Array<{ onclose?: () => void; onerror?: (error: Error) => void }>,
}));
vi.mock('@modelcontextprotocol/client', async (original) => ({
  ...(await original<typeof import('@modelcontextprotocol/client')>()),
  Client: class {
    onclose?: () => void;
    onerror?: (error: Error) => void;
    constructor() {
      client.instances.push(this);
    }
    connect = client.connect;
    listTools = client.listTools;
    callTool = client.callTool;
    close = client.close;
  },
}));
let root: string;
beforeEach(() => {
  vi.resetModules();
  root = mkdtempSync(join(tmpdir(), 'openbutler-mcp-timeout-'));
  vi.stubEnv('OPENBUTLER_DATA_DIR', root);
  vi.useFakeTimers();
  client.connect.mockReset().mockResolvedValue(undefined);
  client.instances.length = 0;
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
  if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith('openbutler-mcp-timeout-'))
    throw new Error('Invalid fixture cleanup path.');
  rmSync(root, { recursive: true, force: true });
});

async function configuredServer() {
  const settings = await import('../../src/settings.js');
  expect(settings.getSettingsPath()).toBe(join(root, 'settings.yaml'));
  const config = { transport: 'http' as const, url: 'https://fixture.invalid/mcp', headers: {} };
  const store = settings.defaultSettings();
  store.mcpServers.fixture = config;
  settings.saveSettings(store);
  return config;
}

it('shares one connection across simultaneous requests and reconnects a real close without replaying calls', async () => {
  const config = await configuredServer();
  const { createMcpConnectionManager } = await import('../../src/tools/mcp.js');
  const manager = createMcpConnectionManager({ onError: vi.fn(), onConnected: vi.fn() });
  try {
    await Promise.all([manager.reload({ fixture: config }), manager.connectServer('fixture'), manager.reload({ fixture: config })]);
    expect(client.connect).toHaveBeenCalledOnce();
    const tools = manager.tools;
    const revision = manager.revision;
    client.callTool.mockRejectedValueOnce(new Error('Connection lost during tool call'));
    await expect(tools[0]!.execute({})).rejects.toThrow('Connection lost');
    expect(client.callTool).toHaveBeenCalledOnce();
    client.instances[0]!.onclose!();
    expect(manager.revision).toBeGreaterThan(revision);
    expect(manager.list()[0]).toMatchObject({ connected: false, state: 'retrying', retryAt: expect.any(Number) });
    expect(manager.tools).toEqual([]);
    await expect(tools[0]!.execute({})).rejects.toThrow('disconnected');
    await vi.advanceTimersByTimeAsync(5000);
    expect(client.connect).toHaveBeenCalledTimes(2);
    expect(client.callTool).toHaveBeenCalledOnce();
    expect(manager.list()[0]).toMatchObject({ connected: true, state: 'connected', retryAt: null });
    client.callTool.mockResolvedValueOnce({ content: [{ type: 'text', text: 'New call' }] });
    await expect(tools[0]!.execute({})).resolves.toMatchObject({ content: [{ text: 'New call' }] });
    expect(client.callTool).toHaveBeenCalledTimes(2);
    await manager.disconnectServer('fixture');
    await vi.advanceTimersByTimeAsync(120000);
    await manager.reload({ fixture: config });
    expect(client.connect).toHaveBeenCalledTimes(2);
    expect(manager.list()[0]).toMatchObject({ connected: false, state: 'disconnected', retryAt: null });
  } finally {
    await manager.close();
  }
  expect(vi.getTimerCount()).toBe(0);
});

it('retries failed startup with backoff and never retries on every settings reload', async () => {
  const config = await configuredServer();
  const { connectMcpServers } = await import('../../src/tools/mcp.js');
  client.connect.mockRejectedValueOnce(new Error('Offline'));
  const manager = await connectMcpServers({ fixture: config }, { onError: vi.fn(), onConnected: vi.fn() });
  try {
    expect(manager.list()[0]).toMatchObject({ connected: false, state: 'retrying' });
    await manager.reload({ fixture: config });
    expect(client.connect).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(5000);
    expect(client.connect).toHaveBeenCalledTimes(2);
    expect(manager.list()[0]?.connected).toBe(true);
  } finally {
    await manager.close();
  }
});

it('distinguishes a request timeout from a lost HTTP session and an SDK disconnected call', async () => {
  const config = await configuredServer();
  const { connectMcpServers } = await import('../../src/tools/mcp.js');
  const { SdkError, SdkErrorCode, SdkHttpError } = await import('@modelcontextprotocol/client');
  const manager = await connectMcpServers({ fixture: config }, { onError: vi.fn(), onConnected: vi.fn() });
  try {
    client.instances[0]!.onerror!(new SdkError(SdkErrorCode.RequestTimeout, 'Slow request'));
    expect(manager.list()[0]?.connected).toBe(true);
    client.instances[0]!.onerror!(new SdkHttpError(SdkErrorCode.ClientHttpNotImplemented, 'Session expired', { status: 404 }));
    expect(manager.list()[0]).toMatchObject({ connected: false, state: 'retrying' });
    await manager.connectServer('fixture');
    client.callTool.mockRejectedValueOnce(new SdkError(SdkErrorCode.NotConnected, 'Lost transport'));
    await expect(manager.tools[0]!.execute({})).rejects.toThrow('Lost transport');
    expect(manager.list()[0]?.connected).toBe(false);
    expect(client.callTool).toHaveBeenCalledOnce();
  } finally {
    await manager.close();
  }
});

it('does not reconnect when only configuration key order changes', async () => {
  const { connectMcpServers } = await import('../../src/tools/mcp.js');
  const config = { transport: 'http' as const, url: 'https://fixture.invalid/mcp', headers: { first: 'PATH', second: 'PATH' } };
  const manager = await connectMcpServers({ fixture: config }, { onError: vi.fn(), onConnected: vi.fn() });
  try {
    expect(await manager.reload({ fixture: { ...config, headers: { second: 'PATH', first: 'PATH' } } })).toBe(false);
    expect(client.connect).toHaveBeenCalledOnce();
  } finally {
    await manager.close();
  }
});

it('defers automatic replacement while another chat is active and rejects calls captured for the old endpoint', async () => {
  const config = await configuredServer();
  const { connectMcpServers } = await import('../../src/tools/mcp.js');
  let idle = true;
  const manager = await connectMcpServers({ fixture: config }, { onError: vi.fn(), onConnected: vi.fn(), canReconfigure: () => idle });
  try {
    const tools = manager.tools;
    idle = false;
    const updated = { ...config, url: 'https://fixture.invalid/replaced' };
    expect(await manager.reload({ fixture: updated })).toBe(false);
    expect(client.connect).toHaveBeenCalledOnce();
    idle = true;
    expect(await manager.reload({ fixture: updated })).toBe(true);
    client.instances[0]!.onclose!();
    expect(manager.list()[0]?.connected).toBe(true);
    await expect(tools[0]!.execute({})).rejects.toThrow('configuration changed');
    expect(client.callTool).not.toHaveBeenCalled();
  } finally {
    await manager.close();
  }
});

it('cancels a pending connection when its owner shuts down', async () => {
  const config = await configuredServer();
  const { createMcpConnectionManager } = await import('../../src/tools/mcp.js');
  const errors = vi.fn();
  const manager = createMcpConnectionManager({ onError: errors, onConnected: vi.fn() });
  let started!: () => void;
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  client.connect.mockImplementationOnce(() => {
    started();
    return new Promise(() => {});
  });
  const opening = manager.reload({ fixture: config });
  const rejected = expect(opening).rejects.toThrow('closed');
  await entered;
  await manager.close();
  await rejected;
  expect(client.close).toHaveBeenCalledOnce();
  expect(errors).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it('keeps a healthy connection when a chat starts during its replacement handshake', async () => {
  const config = await configuredServer();
  const { connectMcpServers } = await import('../../src/tools/mcp.js');
  const connected = vi.fn();
  let idle = true;
  const manager = await connectMcpServers({ fixture: config }, { onError: vi.fn(), onConnected: connected, canReconfigure: () => idle });
  try {
    const tools = manager.tools;
    client.connect.mockImplementationOnce(async () => {
      idle = false;
    });
    expect(await manager.reload({ fixture: { ...config, url: 'https://fixture.invalid/updated' } })).toBe(false);
    expect(manager.tools).toBe(tools);
    expect(manager.list()[0]?.connected).toBe(true);
    expect(connected).toHaveBeenCalledOnce();
    client.callTool.mockResolvedValueOnce({ content: [{ type: 'text', text: 'Original connection' }] });
    await expect(tools[0]!.execute({})).resolves.toMatchObject({ content: [{ text: 'Original connection' }] });
  } finally {
    await manager.close();
  }
});

it('refreshes an in-flight chat catalogue when another chat or automatic recovery changes its connections', async () => {
  const config = await configuredServer();
  const { createMcpConnectionManager, createMcpManagementTool } = await import('../../src/tools/mcp.js');
  const manager = createMcpConnectionManager({ onError: vi.fn(), onConnected: vi.fn() });
  const changed = vi.fn();
  const control = createMcpManagementTool(manager, changed);
  try {
    await manager.reload({ fixture: config });
    expect(await control.execute({ action: 'list' })).toMatchObject({ changed: true });
    expect(control.restartAfterExecute?.({ changed: true })).toBe(true);
    expect(await control.execute({ action: 'list' })).toMatchObject({ changed: false });
    expect(changed).toHaveBeenCalledOnce();
    client.instances[0]!.onclose!();
    await vi.advanceTimersByTimeAsync(5000);
    expect(await control.execute({ action: 'connect', serverId: 'fixture' })).toMatchObject({ changed: true });
    expect(client.connect).toHaveBeenCalledTimes(2);
  } finally {
    await manager.close();
  }
});

it('reconciles changed MCP settings without restarting unchanged or manually disconnected servers', async () => {
  const { connectMcpServers } = await import('../../src/tools/mcp.js');
  const original = { transport: 'http' as const, url: 'https://fixture.invalid/first', headers: {} };
  const manager = await connectMcpServers({ fixture: original }, { onError: vi.fn(), onConnected: vi.fn() });
  try {
    expect(await manager.reload({ fixture: original })).toBe(false);
    expect(client.connect).toHaveBeenCalledTimes(1);
    const updated = { ...original, url: 'https://fixture.invalid/second' };
    expect(await manager.reload({ fixture: updated })).toBe(true);
    expect(client.connect).toHaveBeenCalledTimes(2);
    expect(client.close).toHaveBeenCalledTimes(1);
    await manager.disconnectServer('fixture');
    expect(await manager.reload({ fixture: updated })).toBe(false);
    expect(client.connect).toHaveBeenCalledTimes(2);
    expect(await manager.reload({})).toBe(true);
    expect(manager.tools).toEqual([]);
  } finally {
    await manager.close();
  }
});

it('preserves MCP titles verbatim and honors title precedence', async () => {
  client.listTools.mockResolvedValueOnce({
    tools: [
      {
        name: 'athena_search',
        title: 'Search the web',
        annotations: { title: 'Ignored legacy title' },
        description: 'Search.',
        inputSchema: { type: 'object' },
      },
      { name: 'legacy', annotations: { title: ' Read  web pages ' }, description: 'Read.', inputSchema: { type: 'object' } },
      { name: 'untitled', description: 'No title supplied.', inputSchema: { type: 'object' } },
    ],
  });
  const { connectMcpServers } = await import('../../src/tools/mcp.js');
  const manager = await connectMcpServers(
    { fixture: { transport: 'http', url: 'https://fixture.invalid/mcp', headers: {} } },
    { onError: vi.fn(), onConnected: vi.fn() },
  );
  try {
    expect(manager.tools.map((tool) => tool.title)).toEqual(['Search the web', ' Read  web pages ', undefined]);
  } finally {
    await manager.close();
  }
});

it('keeps a working MCP connection when its edited replacement fails', async () => {
  const { connectMcpServers } = await import('../../src/tools/mcp.js');
  const original = { transport: 'http' as const, url: 'https://fixture.invalid/first', headers: {} };
  const manager = await connectMcpServers({ fixture: original }, { onError: vi.fn(), onConnected: vi.fn() });
  try {
    const tools = manager.tools;
    client.connect.mockRejectedValueOnce(new Error('Fixture connection failed'));
    expect(await manager.reload({ fixture: { ...original, url: 'https://fixture.invalid/failing' } })).toBe(false);
    expect(manager.tools).toEqual(tools);
    expect(await manager.reload({ fixture: original })).toBe(false);
  } finally {
    await manager.close();
  }
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

it('stops retrying a server that never connects and hands it to the operator', async () => {
  const config = await configuredServer();
  const { connectMcpServers } = await import('../../src/tools/mcp.js');
  const errors = vi.fn();
  client.connect.mockRejectedValue(new Error('Sign-in required'));
  const manager = await connectMcpServers({ fixture: config }, { onError: errors, onConnected: vi.fn() });
  try {
    expect(client.connect).toHaveBeenCalledTimes(1);
    expect(manager.list()[0]).toMatchObject({ state: 'retrying', retryAt: expect.any(Number) });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(client.connect).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(client.connect).toHaveBeenCalledTimes(3);
    // The third failure ends the loop: the server becomes an operator problem.
    expect(manager.list()[0]).toMatchObject({ state: 'attention', retryAt: null, connected: false });
    expect(manager.list()[0]?.lastError).toContain('automatic retry stopped');
    expect(errors).toHaveBeenCalledWith('fixture', expect.stringContaining('automatic retry stopped'));
    await vi.advanceTimersByTimeAsync(600_000);
    expect(client.connect).toHaveBeenCalledTimes(3);
    // Reloading the same configuration must not restart the churn.
    expect(await manager.reload({ fixture: config })).toBe(false);
    expect(client.connect).toHaveBeenCalledTimes(3);
    // A changed configuration is a new server: its attempts start over.
    const changed = { ...config, url: 'https://fixture.invalid/other' };
    await manager.reload({ fixture: changed });
    expect(client.connect).toHaveBeenCalledTimes(4);
    expect(manager.list()[0]).toMatchObject({ state: 'retrying', retryAt: expect.any(Number) });
    // A manual connect resets the attempts as well and can finish the sign-in.
    client.connect.mockResolvedValue(undefined);
    await manager.connectServer('fixture');
    expect(client.connect).toHaveBeenCalledTimes(5);
    expect(manager.list()[0]).toMatchObject({ state: 'connected', retryAt: null });
  } finally {
    await manager.close();
  }
  expect(vi.getTimerCount()).toBe(0);
});
