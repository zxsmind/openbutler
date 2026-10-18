import { Client, SSEClientTransport, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import type { JSONValue } from 'ai';
import type { ToolResultOutput } from '@ai-sdk/provider-utils';
import { imageTypeFromBytes, summarizeFileToolResult, summarizeImageToolResult } from '../image.js';
import { getMcpWorkingDirectory } from '../paths.js';
import { loadSettings, parseMcpServerState, saveSettings, type McpServerState } from '../settings.js';
import { getRaniteVersion } from '../version.js';
import type { ToolDefinition, ToolEffect } from './registry.js';
import { DEFAULT_TOOL_TIMEOUT_SECONDS, runWithToolTimeout } from './timeout.js';

const MCP_HANDSHAKE_TIMEOUT_MS = 15_000;
const MCP_CLOSE_TIMEOUT_MS = 5_000;

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

type ConnectedMcpServer = { id: string; client: Client; tools: ToolDefinition[] };

export type McpOperation = { signal?: AbortSignal; timeoutSeconds?: number };

export interface McpConnectionManager {
  readonly tools: ToolDefinition[];
  list(): Array<{ id: string; transport: string; connected: boolean; toolCount: number }>;
  addServer(id: string, config: unknown, operation?: McpOperation): Promise<string[]>;
  connectServer(id: string, operation?: McpOperation): Promise<{ connected: boolean; changed: boolean; tools: string[] }>;
  disconnectServer(id: string, operation?: McpOperation): Promise<boolean>;
  removeServer(id: string, operation?: McpOperation): Promise<boolean>;
  close(): Promise<void>;
}

export async function connectMcpServers(
  servers: Record<string, McpServerState>,
  options: {
    onError: (serverId: string, message: string) => void;
    onConnected: (serverId: string, toolCount: number) => void;
    inputModalities?: () => readonly string[];
  },
): Promise<McpConnectionManager> {
  const connected = new Map<string, ConnectedMcpServer>();

  try {
    for (const [id, config] of Object.entries(servers)) {
      const connection = await openMcpServer(id, config, options, false);
      if (connection) connected.set(id, connection);
    }
  } catch (error) {
    await Promise.all([...connected.values()].map((server) => closeMcpServer(server, options)));
    throw error;
  }

  return {
    get tools() {
      return [...connected.values()].flatMap((server) => server.tools);
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
        };
      });
    },
    async addServer(id, rawConfig, operation) {
      const config = parseMcpServerState(rawConfig, id);
      if (id in loadSettings().mcpServers) throw new Error(`MCP server ${id} is already configured.`);
      const connection = await openMcpServer(id, config, options, true, operation);
      if (!connection) throw new Error(`MCP server ${id} was not connected.`);
      try {
        operation?.signal?.throwIfAborted();
        const settings = loadSettings();
        if (id in settings.mcpServers) throw new Error(`MCP server ${id} is already configured.`);
        settings.mcpServers[id] = config;
        saveSettings(settings);
        connected.set(id, connection);
        return connection.tools.map((tool) => tool.name);
      } catch (error) {
        await closeMcpServer(connection, options);
        throw error;
      }
    },
    async connectServer(id, operation) {
      if (connected.has(id)) return { connected: true, changed: false, tools: connected.get(id)!.tools.map((tool) => tool.name) };
      const config = loadSettings().mcpServers[id];
      if (!config) throw new Error(`MCP server ${id} is not configured.`);
      const connection = await openMcpServer(id, config, options, true, operation);
      if (!connection) throw new Error(`MCP server ${id} was not connected.`);
      connected.set(id, connection);
      return { connected: true, changed: true, tools: connection.tools.map((tool) => tool.name) };
    },
    async disconnectServer(id, operation) {
      const connection = connected.get(id);
      if (!connection) return false;
      connected.delete(id);
      await closeMcpServer(connection, options, operation);
      return true;
    },
    async removeServer(id, operation) {
      const settings = loadSettings();
      if (!(id in settings.mcpServers)) throw new Error(`MCP server ${id} is not configured.`);
      delete settings.mcpServers[id];
      saveSettings(settings);
      const connection = connected.get(id);
      if (connection) {
        connected.delete(id);
        await closeMcpServer(connection, options, operation);
      }
      return true;
    },
    close: async () => {
      await Promise.all([...connected.values()].map((server) => closeMcpServer(server, options)));
      connected.clear();
    },
  };
}

const mcpManagementEffect: ToolEffect = {
  change: 'modify',
  data: 'sensitive',
  network: 'possible',
  reversible: 'compensating',
  outbound: 'tool-server',
};

export function createMcpManagementTool(manager: McpConnectionManager, onConnectionsChanged: () => void): ToolDefinition {
  return {
    providerId: 'host',
    name: 'mcp_manage',
    description:
      'Inspect and manage Ranite global MCP server connections. Actions: list, add, connect, disconnect, remove. For add, provide serverId and a config with stdio command/args/env/cwd or http/sse url/headers. env and headers map server names to existing host environment-variable names, never to secret values. Changes use global settings and connect immediately after approval.',
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
      if (action === 'list') return { status: 'completed', changed: false, servers: manager.list() };
      if (!id) return { status: 'invalid', error: 'serverId is required for this action.' };
      if (action === 'add') {
        if (!isRecord(input.config)) return { status: 'invalid', error: 'config is required when adding an MCP server.' };
        const tools = await manager.addServer(id, input.config, operation);
        onConnectionsChanged();
        return { status: 'completed', changed: true, serverId: id, tools };
      }
      if (action === 'connect') {
        const result = await manager.connectServer(id, operation);
        if (result.changed) onConnectionsChanged();
        return { status: 'completed', changed: result.changed, serverId: id, tools: result.tools };
      }
      if (action === 'disconnect') {
        const changed = await manager.disconnectServer(id, operation);
        if (changed) onConnectionsChanged();
        return { status: 'completed', changed, serverId: id };
      }
      if (action === 'remove') {
        await manager.removeServer(id, operation);
        onConnectionsChanged();
        return { status: 'completed', changed: true, serverId: id };
      }
      return { status: 'invalid', error: 'action must be list, add, connect, disconnect, or remove.' };
    },
  };
}

async function openMcpServer(
  id: string,
  config: McpServerState,
  options: Parameters<typeof connectMcpServers>[1],
  throwOnError: boolean,
  operation?: McpOperation,
): Promise<ConnectedMcpServer | null> {
  const client = new Client({ name: 'ranite', version: getRaniteVersion() });
  try {
    const discover = async (signal: AbortSignal, timeout: number) => {
      await client.connect(createTransport(config), { signal, timeout, maxTotalTimeout: timeout });
      return client.listTools(undefined, { signal, timeout, maxTotalTimeout: timeout });
    };
    const listed = operation
      ? await runWithToolTimeout(operation.timeoutSeconds ?? DEFAULT_TOOL_TIMEOUT_SECONDS, operation.signal, (signal) =>
          discover(signal, (operation.timeoutSeconds ?? DEFAULT_TOOL_TIMEOUT_SECONDS) * 1000),
        )
      : await (async () => {
          await withTimeout(
            (signal) => client.connect(createTransport(config), { signal, timeout: MCP_HANDSHAKE_TIMEOUT_MS }),
            MCP_HANDSHAKE_TIMEOUT_MS,
            'connect',
          );
          return withTimeout(
            (signal) => client.listTools(undefined, { signal, timeout: MCP_HANDSHAKE_TIMEOUT_MS }),
            MCP_HANDSHAKE_TIMEOUT_MS,
            'list tools',
          );
        })();
    const tools: ToolDefinition[] = [];
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
      tools.push({
        providerId: `mcp-${id}`,
        name: definition.name,
        description,
        inputSchema: definition.inputSchema as Record<string, unknown>,
        effect: { change: 'unknown', data: 'unknown', network: 'used', reversible: 'unknown', outbound: 'model-and-tool-server' },
        execute: async (input, signal, context) =>
          runWithToolTimeout(context?.timeoutSeconds ?? DEFAULT_TOOL_TIMEOUT_SECONDS, signal, async (operationSignal) =>
            normalizeMcpResult(
              await client.callTool(
                { name: definition.name, arguments: input },
                {
                  requestSignal: operationSignal,
                  timeout: (context?.timeoutSeconds ?? DEFAULT_TOOL_TIMEOUT_SECONDS) * 1000,
                  maxTotalTimeout: (context?.timeoutSeconds ?? DEFAULT_TOOL_TIMEOUT_SECONDS) * 1000,
                },
              ),
              options.inputModalities?.() ?? ['text'],
            ),
          ),
        toModelOutput: (output) =>
          summarizeImageToolResult(output) !== null || summarizeFileToolResult(output) !== null
            ? (output as ToolResultOutput)
            : { type: 'json', value: output as JSONValue },
      });
    }
    if (listed.tools.length > 256)
      options.onError(id, `The server advertised ${listed.tools.length} tools; only the first 256 are available.`);
    options.onConnected(id, tools.length);
    return { id, client, tools };
  } catch (error) {
    await withTimeout(() => client.close(), MCP_CLOSE_TIMEOUT_MS, 'shutdown').catch(() => undefined);
    const message = error instanceof Error ? error.message : String(error);
    options.onError(id, message);
    if (throwOnError) throw new Error(`Could not connect MCP server ${id}: ${message}`);
    return null;
  }
}

async function closeMcpServer(
  server: ConnectedMcpServer,
  options: Parameters<typeof connectMcpServers>[1],
  operation?: McpOperation,
): Promise<void> {
  try {
    if (operation)
      await runWithToolTimeout(operation.timeoutSeconds ?? DEFAULT_TOOL_TIMEOUT_SECONDS, operation.signal, () => server.client.close());
    else await withTimeout(() => server.client.close(), MCP_CLOSE_TIMEOUT_MS, 'shutdown');
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
async function withTimeout<T>(operation: (signal: AbortSignal) => Promise<T>, timeoutMs: number, label: string): Promise<T> {
  const controller = new AbortController();
  const timeoutError = new Error('MCP ' + label + ' timed out after ' + timeoutMs + ' ms.');
  const timer = setTimeout(() => controller.abort(timeoutError), timeoutMs);
  try {
    return await Promise.race([
      operation(controller.signal),
      new Promise<never>((_resolve, reject) => {
        if (controller.signal.aborted) {
          reject(timeoutError);
          return;
        }
        controller.signal.addEventListener('abort', () => reject(timeoutError), { once: true });
      }),
    ]);
  } finally {
    clearTimeout(timer);
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
      stderr: 'ignore',
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
