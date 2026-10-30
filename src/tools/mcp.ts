import {
  Client,
  SdkError,
  SdkErrorCode,
  SdkHttpError,
  SSEClientTransport,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import type { JSONValue } from 'ai';
import type { ToolResultOutput } from '@ai-sdk/provider-utils';
import { imageTypeFromBytes, summarizeFileToolResult, summarizeImageToolResult } from '../image.js';
import { getMcpWorkingDirectory } from '../paths.js';
import { killProcessTree } from '../process-tree.js';
import { loadSettings, parseMcpServerState, saveSettings, type McpServerState } from '../settings.js';
import { getOpenButlerVersion } from '../version.js';
import type { ToolDefinition, ToolEffect } from './registry.js';
import { DEFAULT_TOOL_TIMEOUT_SECONDS, runWithToolTimeout } from './timeout.js';
import { redactSensitiveText } from '../sensitive-data.js';

const MCP_HANDSHAKE_TIMEOUT_MS = 15_000;
const MCP_CLOSE_TIMEOUT_MS = 5_000;
/** Connection attempts before a server that never connects becomes an operator problem. */
const MCP_CONNECT_ATTEMPTS_LIMIT = 3;

export interface McpServerRequest {
  id: string;
  transport: McpServerState['transport'];
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

type ConnectedMcpServer = {
  id: string;
  client: Client;
  tools: ToolDefinition[];
  alive: boolean;
  expectedClose: boolean;
  stderr: string;
  /** Reads the stdio child pid lazily: it only exists once the transport has spawned. */
  transportPid?: () => number | null;
  /** The command this server was spawned with, used to verify a tree kill before it runs. */
  spawn?: { command: string; args: readonly string[] };
};

export type McpOperation = { signal?: AbortSignal; timeoutSeconds?: number };

export interface McpConnectionManager {
  readonly revision: number;
  readonly tools: ToolDefinition[];
  list(): Array<{
    id: string;
    transport: string;
    connected: boolean;
    toolCount: number;
    state: 'connecting' | 'connected' | 'retrying' | 'attention' | 'disconnected';
    retryAt: number | null;
    lastError: string | null;
  }>;
  addServer(id: string, config: unknown, operation?: McpOperation): Promise<string[]>;
  connectServer(id: string, operation?: McpOperation): Promise<{ connected: boolean; changed: boolean; tools: string[] }>;
  disconnectServer(id: string, operation?: McpOperation): Promise<boolean>;
  removeServer(id: string, operation?: McpOperation): Promise<boolean>;
  reload(servers: Record<string, McpServerState>): Promise<boolean>;
  close(): Promise<void>;
}

interface McpConnectionOptions {
  onError: (serverId: string, message: string) => void;
  onConnected: (serverId: string, toolCount: number) => void;
  inputModalities?: () => readonly string[];
  /** Automatic configuration replacement waits until all host sessions are idle. */
  canReconfigure?: () => boolean;
}

function connectionSignature(config: McpServerState): string {
  return JSON.stringify(config, (_key, value: unknown) =>
    isRecord(value)
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, value[key]]),
        )
      : value,
  );
}

function connectionLost(error: unknown): boolean {
  return (
    (error instanceof SdkError && (error.code === SdkErrorCode.NotConnected || error.code === SdkErrorCode.ConnectionClosed)) ||
    (error instanceof SdkHttpError && isRecord(error.data) && (error.data.status === 404 || error.data.status === 410))
  );
}

/**
 * The daemon owns transports; chat catalogues borrow definitions with per-call capabilities.
 * Management operations are serialized, independent server handshakes run in parallel.
 * Recovery reconnects transports only: an interrupted tool call is never replayed here.
 */
export function createMcpConnectionManager(options: McpConnectionOptions): McpConnectionManager {
  const connected = new Map<string, ConnectedMcpServer>();
  const configurations = new Map<string, string>();
  const suspended = new Set<string>();
  const connecting = new Set<string>();
  const errors = new Map<string, string>();
  const retries = new Map<string, { signature: string; attempt: number; at: number }>();
  /** Servers whose attempts ran out: kept out of the retry loop until a connect or a config change. */
  const attention = new Map<string, { signature: string; message: string }>();
  const shutdown = new AbortController();
  let revision = 0;
  let closed = false;
  let operations = Promise.resolve();
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let closing: Promise<void> | undefined;
  let toolSnapshot: { revision: number; tools: ToolDefinition[] } | undefined;

  function serialize<T>(operation: () => Promise<T>): Promise<T> {
    const next = operations.then(() => {
      if (closed) throw new Error('The MCP manager is closed.');
      return operation();
    });
    operations = next.then(
      () => {},
      () => {},
    );
    return next;
  }
  function scheduleRetry(): void {
    clearTimeout(retryTimer);
    if (closed || retries.size === 0) return;
    const due = Math.min(...[...retries.values()].map((retry) => retry.at));
    retryTimer = setTimeout(
      () => {
        void Promise.resolve()
          .then(() => manager.reload(loadSettings().mcpServers))
          .catch((error: unknown) => {
            options.onError('host', redactSensitiveText(String(error)));
            for (const pending of retries.values()) pending.at = Date.now() + 60_000;
            scheduleRetry();
          });
      },
      Math.max(1000, due - Date.now()),
    );
    retryTimer.unref?.();
  }
  function retry(id: string, signature: string): void {
    const previous = retries.get(id);
    const attempt = previous?.signature === signature ? previous.attempt + 1 : 1;
    if (attempt >= MCP_CONNECT_ATTEMPTS_LIMIT) {
      // A server that never connects — an unfinished sign-in, a dead endpoint — must not
      // churn for ever: it becomes a visible operator problem with its last error attached.
      retries.delete(id);
      const detail = errors.get(id);
      const message = redactSensitiveText(
        `MCP server ${id}: ${MCP_CONNECT_ATTEMPTS_LIMIT} connection attempts failed; automatic retry stopped. ` +
          'Connect it again (mcp_manage connect) and complete any sign-in its output asks for, or remove the server.' +
          (detail ? ` Last error: ${detail}` : ''),
      );
      attention.set(id, { signature, message });
      errors.set(id, message);
      scheduleRetry();
      options.onError(id, message);
      return;
    }
    retries.set(id, { signature, attempt, at: Date.now() + Math.min(60_000, 5000 * 2 ** Math.min(attempt - 1, 4)) });
    scheduleRetry();
  }
  function lost(server: ConnectedMcpServer): void {
    if (closed || connected.get(server.id) !== server) return;
    connected.delete(server.id);
    revision++;
    const message = redactSensitiveText(`Connection closed.${server.stderr ? ` Server output: ${server.stderr}` : ''}`);
    errors.set(server.id, message);
    options.onError(server.id, message);
    server.expectedClose = true;
    operations = operations
      .then(() => closeMcpServer(server, options))
      .catch((error: unknown) => {
        options.onError(server.id, redactSensitiveText(String(error)));
      });
    retry(server.id, configurations.get(server.id) ?? '');
  }
  async function open(id: string, config: McpServerState, operation?: McpOperation): Promise<ConnectedMcpServer | null> {
    connecting.add(id);
    try {
      const next = await openMcpServer(
        id,
        config,
        {
          ...options,
          onError: (serverId, message) => {
            const safe = redactSensitiveText(message);
            errors.set(serverId, safe);
            options.onError(serverId, safe);
          },
        },
        operation,
        lost,
        shutdown.signal,
      );
      if (closed || operation?.signal?.aborted) {
        if (next) await closeMcpServer(next, options);
        if (closed) throw new Error('The MCP manager is closed.');
        operation?.signal?.throwIfAborted();
      }
      if (!next) retry(id, connectionSignature(config));
      return next;
    } finally {
      connecting.delete(id);
    }
  }
  async function publish(id: string, config: McpServerState, next: ConnectedMcpServer): Promise<void> {
    const previous = connected.get(id);
    connected.set(id, next);
    configurations.set(id, connectionSignature(config));
    suspended.delete(id);
    retries.delete(id);
    attention.delete(id);
    errors.delete(id);
    revision++;
    scheduleRetry();
    options.onConnected(id, next.tools.length);
    if (previous) await closeMcpServer(previous, options);
  }

  const manager: McpConnectionManager = {
    get revision() {
      return revision;
    },
    get tools() {
      if (toolSnapshot?.revision === revision) return toolSnapshot.tools;
      const tools = [...connected.values()].flatMap((server) => {
        const signature = configurations.get(server.id);
        return server.tools.map((definition): ToolDefinition => ({
          ...definition,
          execute: async (input, signal, context) => {
            const active = connected.get(server.id);
            const current = active?.tools.find(
              (tool) => tool.name === definition.name && JSON.stringify(tool.inputSchema) === JSON.stringify(definition.inputSchema),
            );
            if (!current || configurations.get(server.id) !== signature)
              throw new Error(`MCP server ${server.id} is disconnected or its configuration changed. The call was not sent.`);
            return current.execute(input, signal, context);
          },
        }));
      });
      toolSnapshot = { revision, tools };
      return tools;
    },
    list() {
      const settings = loadSettings();
      return Object.entries(settings.mcpServers).map(([id, config]) => {
        const active = connected.get(id);
        return {
          id,
          transport: config.transport,
          connected: active !== undefined,
          toolCount: active?.tools.length ?? 0,
          state: connecting.has(id)
            ? 'connecting'
            : active
              ? 'connected'
              : retries.has(id)
                ? 'retrying'
                : attention.has(id)
                  ? 'attention'
                  : 'disconnected',
          retryAt: retries.get(id)?.at ?? null,
          lastError: errors.get(id) ?? null,
        };
      });
    },
    addServer: (id, rawConfig, operation) =>
      serialize(async () => {
        operation?.signal?.throwIfAborted();
        const config = parseMcpServerState(rawConfig, id);
        if (id in loadSettings().mcpServers) throw new Error(`MCP server ${id} is already configured.`);
        const connection = await open(id, config, operation);
        if (!connection) {
          retries.delete(id);
          scheduleRetry();
          throw new Error(`MCP server ${id} was not connected.`);
        }
        try {
          operation?.signal?.throwIfAborted();
          const settings = loadSettings();
          if (id in settings.mcpServers) throw new Error(`MCP server ${id} is already configured.`);
          settings.mcpServers[id] = config;
          saveSettings(settings);
          await publish(id, config, connection);
          return connection.tools.map((tool) => tool.name);
        } catch (error) {
          await closeMcpServer(connection, options);
          retries.delete(id);
          scheduleRetry();
          throw error;
        }
      }),
    connectServer: (id, operation) =>
      serialize(async () => {
        operation?.signal?.throwIfAborted();
        const config = loadSettings().mcpServers[id];
        if (!config) throw new Error(`MCP server ${id} is not configured.`);
        const active = connected.get(id);
        if (active?.alive && configurations.get(id) === connectionSignature(config))
          return { connected: true, changed: false, tools: active.tools.map((tool) => tool.name) };
        suspended.delete(id);
        // A manual connect is a fresh start: it resets the attempt counter and the terminal state.
        retries.delete(id);
        attention.delete(id);
        const connection = await open(id, config, operation);
        if (!connection) throw new Error(`MCP server ${id} was not connected.`);
        await publish(id, config, connection);
        return { connected: true, changed: true, tools: connection.tools.map((tool) => tool.name) };
      }),
    disconnectServer: (id, operation) =>
      serialize(async () => {
        operation?.signal?.throwIfAborted();
        suspended.add(id);
        const config = loadSettings().mcpServers[id];
        if (config) configurations.set(id, connectionSignature(config));
        retries.delete(id);
        attention.delete(id);
        scheduleRetry();
        const connection = connected.get(id);
        if (!connection) return false;
        connected.delete(id);
        revision++;
        await closeMcpServer(connection, options);
        return true;
      }),
    removeServer: (id, operation) =>
      serialize(async () => {
        operation?.signal?.throwIfAborted();
        const settings = loadSettings();
        if (!(id in settings.mcpServers)) throw new Error(`MCP server ${id} is not configured.`);
        delete settings.mcpServers[id];
        saveSettings(settings);
        configurations.delete(id);
        suspended.delete(id);
        retries.delete(id);
        attention.delete(id);
        errors.delete(id);
        scheduleRetry();
        const connection = connected.get(id);
        if (connection) {
          connected.delete(id);
          revision++;
          await closeMcpServer(connection, options);
        }
        return true;
      }),
    reload: (servers) =>
      serialize(async () => {
        let changed = false;
        const results = await Promise.allSettled(
          Object.entries(servers).map(async ([id, config]) => {
            const signature = connectionSignature(config);
            const pending = retries.get(id);
            if (pending && pending.signature !== signature) retries.delete(id);
            const stopped = attention.get(id);
            if (stopped && stopped.signature !== signature) attention.delete(id);
            if (configurations.get(id) === signature && (connected.has(id) || suspended.has(id))) return;
            if (connected.has(id) && options.canReconfigure?.() === false) return;
            if (pending?.signature === signature && pending.at > Date.now()) return;
            // Terminal until the configuration changes or an operator connects it on purpose.
            if (attention.get(id)?.signature === signature) return;
            const next = await open(id, config);
            if (!next) return;
            // A turn may have started while the replacement handshake was pending.
            if (connected.has(id) && options.canReconfigure?.() === false) {
              await closeMcpServer(next, options);
              retry(id, signature);
              return;
            }
            await publish(id, config, next);
            changed = true;
          }),
        );
        const failed = results.find((result) => result.status === 'rejected');
        if (failed?.status === 'rejected') throw failed.reason;
        for (const id of new Set([...configurations.keys(), ...retries.keys(), ...attention.keys(), ...suspended])) {
          if (Object.hasOwn(servers, id)) continue;
          if (connected.has(id) && options.canReconfigure?.() === false) continue;
          const previous = connected.get(id);
          connected.delete(id);
          configurations.delete(id);
          suspended.delete(id);
          retries.delete(id);
          errors.delete(id);
          if (previous) revision++;
          if (previous) await closeMcpServer(previous, options);
          changed = true;
        }
        scheduleRetry();
        return changed;
      }),
    close: () => {
      closed = true;
      shutdown.abort(new Error('The MCP manager is closing.'));
      clearTimeout(retryTimer);
      closing ??= operations.then(async () => {
        const active = [...connected.values()];
        connected.clear();
        retries.clear();
        revision++;
        await Promise.all(active.map((server) => closeMcpServer(server, options)));
      });
      return closing;
    },
  };
  return manager;
}

export async function connectMcpServers(
  servers: Record<string, McpServerState>,
  options: McpConnectionOptions,
): Promise<McpConnectionManager> {
  const manager = createMcpConnectionManager(options);
  try {
    await manager.reload(servers);
    return manager;
  } catch (error) {
    await manager.close();
    throw error;
  }
}

const mcpManagementEffect: ToolEffect = {
  change: 'modify',
  data: 'sensitive',
  network: 'possible',
  reversible: 'compensating',
  outbound: 'tool-server',
};

export function createMcpManagementTool(manager: McpConnectionManager, onConnectionsChanged: () => void): ToolDefinition {
  let observedRevision = manager.revision;
  const refreshCatalogue = (force = false) => {
    if (!force && observedRevision === manager.revision) return false;
    onConnectionsChanged();
    observedRevision = manager.revision;
    return true;
  };
  return {
    providerId: 'host',
    name: 'mcp_manage',
    description:
      'Inspect and manage OpenButler global MCP server connections. Actions: list, add, connect, disconnect, remove. For add, provide serverId and a config with stdio command/args/env/cwd or http/sse url/headers. env and headers map server names to existing host environment-variable names, never to secret values. Changes use global settings and connect immediately after approval.',
    maxInputChars: 20_000,
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'add', 'connect', 'disconnect', 'remove'] },
        serverId: { type: 'string', minLength: 1, maxLength: 59 },
        config: {
          type: 'object',
          properties: {
            transport: { type: 'string', enum: ['stdio', 'http', 'sse'] },
            command: { type: 'string' },
            args: { type: 'array', items: { type: 'string' } },
            cwd: { type: 'string' },
            env: { type: 'object', additionalProperties: { type: 'string' } },
            url: { type: 'string' },
            headers: { type: 'object', additionalProperties: { type: 'string' } },
          },
          additionalProperties: false,
        },
      },
      required: ['action'],
      additionalProperties: false,
    },
    effect: mcpManagementEffect,
    assess: (input) => {
      const action = input.action;
      if (action === 'list') return { change: 'none', data: 'local', network: 'none', reversible: 'full', outbound: 'model' };
      if (action === 'connect') return { ...mcpManagementEffect, change: 'execute', network: 'used' };
      if (action === 'disconnect') return { ...mcpManagementEffect, change: 'modify', network: 'possible', outbound: 'none' };
      if (action === 'remove') return { ...mcpManagementEffect, change: 'delete', network: 'possible' };
      return mcpManagementEffect;
    },
    autoApprove: (input) => input.action === 'list',
    restartAfterExecute: (result) => isRecord(result) && result.changed === true,
    execute: async (input, signal, context) => {
      const operation: McpOperation = {
        ...(signal ? { signal } : {}),
        timeoutSeconds: context?.timeoutSeconds ?? DEFAULT_TOOL_TIMEOUT_SECONDS,
      };
      const action = input.action;
      const id = typeof input.serverId === 'string' ? input.serverId : '';
      if (action === 'list') return { status: 'completed', changed: refreshCatalogue(), servers: manager.list() };
      if (!id) return { status: 'invalid', error: 'serverId is required for this action.' };
      if (action === 'add') {
        if (!isRecord(input.config)) return { status: 'invalid', error: 'config is required when adding an MCP server.' };
        const tools = await manager.addServer(id, input.config, operation);
        refreshCatalogue(true);
        return { status: 'completed', changed: true, serverId: id, tools };
      }
      if (action === 'connect') {
        const result = await manager.connectServer(id, operation);
        return { status: 'completed', changed: refreshCatalogue(result.changed), serverId: id, tools: result.tools };
      }
      if (action === 'disconnect') {
        const changed = await manager.disconnectServer(id, operation);
        return { status: 'completed', changed: refreshCatalogue(changed), serverId: id };
      }
      if (action === 'remove') {
        await manager.removeServer(id, operation);
        refreshCatalogue(true);
        return { status: 'completed', changed: true, serverId: id };
      }
      return { status: 'invalid', error: 'action must be list, add, connect, disconnect, or remove.' };
    },
  };
}

async function openMcpServer(
  id: string,
  config: McpServerState,
  options: McpConnectionOptions,
  operation?: McpOperation,
  onDisconnected?: (server: ConnectedMcpServer) => void,
  shutdownSignal?: AbortSignal,
): Promise<ConnectedMcpServer | null> {
  const client = new Client({ name: 'openbutler', version: getOpenButlerVersion() });
  const server: ConnectedMcpServer = { id, client, tools: [], alive: true, expectedClose: false, stderr: '' };
  const secrets = Object.values(config.transport === 'stdio' ? config.env : config.headers)
    .map((name) => process.env[name])
    .filter((value): value is string => Boolean(value));
  const sanitize = (message: string) => redactSensitiveText(secrets.reduce((text, value) => text.replaceAll(value, '[redacted]'), message));
  const disconnected = () => {
    if (!server.alive) return;
    server.alive = false;
    if (!server.expectedClose) onDisconnected?.(server);
  };
  client.onclose = disconnected;
  client.onerror = (error) => {
    if (!server.expectedClose && !shutdownSignal?.aborted) options.onError(id, sanitize(error.message));
    if (connectionLost(error)) disconnected();
  };
  try {
    const transport = createTransport(config);
    if (transport instanceof StdioClientTransport) {
      // Recorded before the handshake so a failed connect can still verify and remove its tree.
      const stdio = transport;
      server.transportPid = () => stdio.pid;
      if (config.transport === 'stdio') server.spawn = { command: config.command, args: config.args };
      let stderr = '';
      transport.stderr?.on('data', (chunk: Buffer) => {
        stderr = (stderr + chunk.toString('utf8')).slice(-8192);
        server.stderr = sanitize(stderr);
      });
    }
    const discover = async (signal: AbortSignal, timeout: number) => {
      await client.connect(transport, { signal, timeout, maxTotalTimeout: timeout });
      return client.listTools(undefined, { signal, timeout, maxTotalTimeout: timeout });
    };
    const listed = operation
      ? await runWithToolTimeout(
          operation.timeoutSeconds ?? DEFAULT_TOOL_TIMEOUT_SECONDS,
          operation.signal && shutdownSignal ? AbortSignal.any([operation.signal, shutdownSignal]) : (operation.signal ?? shutdownSignal),
          (signal) => discover(signal, (operation.timeoutSeconds ?? DEFAULT_TOOL_TIMEOUT_SECONDS) * 1000),
        )
      : await (async () => {
          await withTimeout(
            (signal) => client.connect(transport, { signal, timeout: MCP_HANDSHAKE_TIMEOUT_MS }),
            MCP_HANDSHAKE_TIMEOUT_MS,
            'connect',
            shutdownSignal,
          );
          return withTimeout(
            (signal) => client.listTools(undefined, { signal, timeout: MCP_HANDSHAKE_TIMEOUT_MS }),
            MCP_HANDSHAKE_TIMEOUT_MS,
            'list tools',
            shutdownSignal,
          );
        })();
    const tools: ToolDefinition[] = [];
    if (!server.alive) throw new Error('The MCP server closed during initialization.');
    operation?.signal?.throwIfAborted();
    const names = new Set<string>();
    for (const definition of listed.tools.slice(0, 256)) {
      const schema = JSON.stringify(definition.inputSchema);
      const description = definition.description ?? `MCP tool provided by ${id}.`;
      if (
        !definition.name ||
        definition.name.length > 256 ||
        names.has(definition.name) ||
        !description.trim() ||
        description.length > 8_000 ||
        !isRecord(definition.inputSchema) ||
        !schema ||
        schema.length > 50_000
      )
        continue;
      names.add(definition.name);
      const title = definition.title ?? definition.annotations?.title;
      tools.push({
        providerId: `mcp-${id}`,
        name: definition.name,
        ...(title !== undefined ? { title } : {}),
        description,
        inputSchema: definition.inputSchema as Record<string, unknown>,
        effect: { change: 'unknown', data: 'unknown', network: 'used', reversible: 'unknown', outbound: 'model-and-tool-server' },
        execute: async (input, signal, context) => {
          if (!server.alive) throw new Error(`MCP server ${id} is disconnected. The call was not sent.`);
          try {
            return await runWithToolTimeout(context?.timeoutSeconds ?? DEFAULT_TOOL_TIMEOUT_SECONDS, signal, async (operationSignal) =>
              normalizeMcpResult(
                await client.callTool(
                  { name: definition.name, arguments: input },
                  {
                    requestSignal: operationSignal,
                    timeout: (context?.timeoutSeconds ?? DEFAULT_TOOL_TIMEOUT_SECONDS) * 1000,
                    maxTotalTimeout: (context?.timeoutSeconds ?? DEFAULT_TOOL_TIMEOUT_SECONDS) * 1000,
                  },
                ),
                context?.inputModalities ?? options.inputModalities?.() ?? ['text'],
              ),
            );
          } catch (error) {
            if (connectionLost(error)) disconnected();
            throw error;
          }
        },
        toModelOutput: (output) =>
          summarizeImageToolResult(output) !== null || summarizeFileToolResult(output) !== null
            ? (output as ToolResultOutput)
            : { type: 'json', value: output as JSONValue },
      });
    }
    if (listed.tools.length > 256)
      options.onError(id, `The server advertised ${listed.tools.length} tools; only the first 256 are available.`);
    server.tools = tools;
    return server;
  } catch (error) {
    server.expectedClose = true;
    server.alive = false;
    // A handshake that timed out (an unfinished sign-in, a dead endpoint) must not leave its
    // wrapper's children behind: the verified tree is removed first, and only an unverified
    // pid falls back to the SDK close, which signals the wrapper alone.
    const pid = server.transportPid?.() ?? null;
    const spawn = server.spawn;
    const killed = spawn && pid ? await killProcessTree(pid, spawn.command, spawn.args) : 'unavailable';
    if (killed === 'killed') {
      void client.close().catch(() => undefined);
    } else {
      await withTimeout(() => client.close(), MCP_CLOSE_TIMEOUT_MS, 'shutdown').catch(() => undefined);
    }
    const message = sanitize(
      `${error instanceof Error ? error.message : String(error)}${server.stderr ? ` Server output: ${server.stderr}` : ''}`,
    );
    if (!shutdownSignal?.aborted) options.onError(id, message);
    return null;
  }
}

async function closeMcpServer(server: ConnectedMcpServer, options: Parameters<typeof connectMcpServers>[1]): Promise<void> {
  server.expectedClose = true;
  server.alive = false;
  const spawn = server.spawn;
  const pid = spawn ? (server.transportPid?.() ?? null) : null;
  if (spawn && pid) {
    // The wrapper goes down together with its tree while the pid still verifies as ours: the
    // SDK's own close signals the wrapper only, and its grandchildren (npx, the remote proxy)
    // would then survive as orphans. A tree that is already gone needs no graceful wait.
    const outcome = await killProcessTree(pid, spawn.command, spawn.args);
    if (outcome === 'killed') {
      void server.client.close().catch(() => undefined);
      return;
    }
  }
  try {
    // Cleanup must start even if the caller cancels after removing the connection.
    await withTimeout(() => server.client.close(), MCP_CLOSE_TIMEOUT_MS, 'shutdown');
  } catch (error) {
    options.onError(server.id, error instanceof Error ? error.message : String(error));
  }
}

function normalizeMcpResult(value: unknown, inputModalities: readonly string[]): unknown {
  if (!isRecord(value) || !Array.isArray(value.content)) return value;
  const content: Array<Record<string, unknown>> = [];
  let hasMedia = false;
  for (const part of value.content) {
    if (!isRecord(part)) continue;
    if (part.type === 'text' && typeof part.text === 'string') {
      content.push({ type: 'text', text: part.text });
      continue;
    }
    const resource = part.type === 'resource' && isRecord(part.resource) ? part.resource : part;
    const mediaType = typeof resource.mimeType === 'string' ? resource.mimeType.toLowerCase() : '';
    const data = typeof resource.data === 'string' ? resource.data : typeof resource.blob === 'string' ? resource.blob : '';
    if (!mediaType || !data) {
      if (part.type === 'resource_link' && typeof part.uri === 'string') {
        content.push({ type: 'text', text: 'MCP resource link: ' + part.uri });
      }
      continue;
    }
    const modality = mediaType.startsWith('image/')
      ? 'image'
      : mediaType.startsWith('audio/')
        ? 'audio'
        : mediaType.startsWith('video/')
          ? 'video'
          : mediaType === 'application/pdf'
            ? 'pdf'
            : '';
    if (!modality) continue;
    hasMedia = true;
    const bytes = decodeMcpMedia(data);
    const sizeLimit = modality === 'image' ? 5 * 1024 * 1024 : 10 * 1024 * 1024;
    if (!bytes || bytes.length === 0 || bytes.length > sizeLimit || !inputModalities.includes(modality)) {
      content.push({
        type: 'text',
        text:
          'MCP returned ' +
          mediaType +
          ' content that was not attached because it is invalid, too large, or unsupported by the selected model.',
      });
      continue;
    }
    if (modality === 'image' && imageTypeFromBytes(bytes) !== mediaType) {
      content.push({ type: 'text', text: 'MCP returned an image whose bytes do not match its declared media type.' });
      continue;
    }
    content.push({
      type: modality === 'image' ? 'image-data' : 'file-data',
      data: bytes.toString('base64'),
      mediaType,
      ...(typeof resource.name === 'string' ? { filename: resource.name } : {}),
    });
  }
  if (!hasMedia) return value;
  if (value.isError === true) content.unshift({ type: 'text', text: 'The MCP server marked this result as an error.' });
  if (value.structuredContent !== undefined) {
    const structured = safeJson(value.structuredContent);
    if (structured) content.push({ type: 'text', text: 'Structured result: ' + structured.slice(0, 30_000) });
  }
  return { type: 'content', value: content };
}

function decodeMcpMedia(value: string): Buffer | null {
  const normalized = value.replace(/\s/g, '');
  if (
    !normalized ||
    normalized.length > Math.ceil((10 * 1024 * 1024 * 4) / 3) + 4 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(normalized) ||
    normalized.length % 4 === 1
  )
    return null;
  return Buffer.from(normalized, 'base64');
}

function safeJson(value: unknown): string | null {
  try {
    return JSON.stringify(value) ?? null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Bounds an MCP operation. The signal lets SDK calls abort the underlying request; the race is a
 * backstop for operations that ignore it (for example, closing a transport).
 */
async function withTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  label: string,
  parent?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  const signal = parent ? AbortSignal.any([parent, controller.signal]) : controller.signal;
  const timeoutError = new Error('MCP ' + label + ' timed out after ' + timeoutMs + ' ms.');
  const timer = setTimeout(() => controller.abort(timeoutError), timeoutMs);
  let onAbort: () => void = () => {};
  try {
    return await Promise.race([
      operation(signal),
      new Promise<never>((_resolve, reject) => {
        if (signal.aborted) {
          reject(signal.reason);
          return;
        }
        onAbort = () => reject(signal.reason);
        signal.addEventListener('abort', onAbort, { once: true });
      }),
    ]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
  }
}

/** The directory a stdio MCP server is started in: its declared `cwd`, else the data directory. */
export function resolveStdioWorkingDirectory(configuredCwd?: string): string {
  return configuredCwd && configuredCwd.length > 0 ? configuredCwd : getMcpWorkingDirectory();
}

function createTransport(config: McpServerState) {
  if (config.transport === 'stdio') {
    const env = getDefaultEnvironment();
    for (const [target, source] of Object.entries(config.env)) {
      const value = process.env[source];
      if (!value) throw new Error(`MCP environment variable ${source} is not set.`);
      env[target] = value;
    }
    return new StdioClientTransport({
      command: config.command,
      args: config.args,
      env,
      stderr: 'pipe',
      // Never inherit this process's directory: the server would write its scratch
      // files into the checkout or into whatever project the user was standing in.
      cwd: resolveStdioWorkingDirectory(config.cwd),
    });
  }

  const headers: Record<string, string> = {};
  for (const [header, source] of Object.entries(config.headers)) {
    const value = process.env[source];
    if (!value) throw new Error(`MCP environment variable ${source} is not set.`);
    headers[header] = value;
  }
  const url = new URL(config.url);
  const options = { requestInit: { headers, redirect: 'error' as const } };
  return config.transport === 'http' ? new StreamableHTTPClientTransport(url, options) : new SSEClientTransport(url, options);
}
