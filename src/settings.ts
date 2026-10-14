import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { load as parseYaml, dump as dumpYaml } from 'js-yaml';
import { getDataPath } from './paths.js';

/**
 * Persisted configuration.
 *
 * One file, one place, written atomically. Keys live here rather than in the
 * environment so the setup wizard has something to edit; the environment still
 * wins at resolve time for a provider the catalog names no variable for.
 *
 * The schema is closed: an unknown key fails instead of being ignored. A typo
 * that silently fell back to a default is a bug that surfaces days later.
 */

export interface ProviderState {
  enabled: boolean;
  keys: string[];
  /** Model IDs the user has selected for this provider, including custom endpoints. */
  models?: string[];
  url?: string;
  npm?: string;
  /**
   * Raw options handed to the runtime package, applied last.
   *
   * Ranite does not read these: they are whatever the package accepts, which is
   * how a provider that needs more than a key — an AWS region, a Google project,
   * an Azure resource name — becomes configurable without a code change here.
   */
  options?: Record<string, unknown>;
}

/** MCP credentials are environment-variable names, never secret values. */
export type McpServerState =
  | { transport: 'stdio'; command: string; args: string[]; env: Record<string, string>; cwd?: string }
  | { transport: 'http' | 'sse'; url: string; headers: Record<string, string> };

export interface BackgroundTaskState {
  id: string;
  name: string;
  enabled: boolean;
  workspaceRoot: string;
  instruction: string;
  trigger: { adapter: string; options: Record<string, unknown> };
}

export interface TelegramSettings {
  enabled: boolean;
  tokenEnv: string;
  workspaceRoot: string;
  chatId?: string;
  userId?: string;
}

export type ApprovalMode = 'workspace' | 'auto-review' | 'full-access';

export interface SettingsStore {
  providers: Record<string, ProviderState>;
  mcpServers: Record<string, McpServerState>;
  /** Try order for provider lookups. */
  providerOrder: string[];
  /**
   * The one model a run uses.
   *
   * A provider used to carry a model list where empty meant "every model the
   * catalog has". That was borrowed from a router, which tries models in turn.
   * Ranite picks one model and uses it, so the list had no meaning: an empty
   * one read as "I added 44 models" when the operator had added none. One field,
   * one meaning.
   */
  defaultProvider: string;
  defaultModel: string;
  /** Preferred reasoning variant id; unsupported choices fall back to Default per model. */
  reasoning?: string;
  /** Whether reasoning deltas are shown in the session transcript. */
  showReasoning?: boolean;
  /** TUI appearance: Dark, Light, or System (System follows the terminal background). */
  theme?: 'Dark' | 'Light' | 'System';
  /** Who decides actions that reach the explicit permission gate. */
  approvalMode: ApprovalMode;
  /**
   * How long an auto-review decision may take before it gives up and asks the
   * user. Slow or rate-limited providers need more than the built-in default;
   * too small a value turns every outside action into a manual prompt.
   */
  autoReviewTimeoutSeconds?: number;
  /** Explicit user tasks. An empty list starts no observers or scheduled model calls. */
  backgroundTasks: BackgroundTaskState[];
  /** Workspace used by bare Ranite launches; it does not define the machine custodian identity. */
  defaultWorkspaceRoot?: string;
  telegram?: TelegramSettings;
}

const SETTINGS_FILE = getDataPath('settings.yaml');

const KNOWN_KEYS = new Set([
  'providers',
  'mcpServers',
  'providerOrder',
  'defaultProvider',
  'defaultModel',
  'reasoning',
  'showReasoning',
  'theme',
  'approvalMode',
  'autoReviewTimeoutSeconds',
  'backgroundTasks',
  'defaultWorkspaceRoot',
  'telegram',
]);
const KNOWN_PROVIDER_KEYS = new Set(['enabled', 'keys', 'models', 'url', 'npm', 'options']);

function isEnvironmentName(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}

/** Maps names exposed to an MCP server to host environment-variable names. */
function environmentReferences(
  value: unknown,
  where: string,
  isTargetName: (value: string) => boolean = isEnvironmentName,
): Record<string, string> {
  if (value === undefined) return {};
  if (!isRecord(value)) throw new Error(`${where} must map names to environment-variable names`);
  const result: Record<string, string> = {};
  for (const [key, reference] of Object.entries(value)) {
    if (
      ['__proto__', 'prototype', 'constructor'].includes(key) ||
      !isTargetName(key) ||
      typeof reference !== 'string' ||
      !isEnvironmentName(reference)
    ) {
      throw new Error(`${where}.${key} must name a host environment variable`);
    }
    result[key] = reference;
  }
  return result;
}

export function parseMcpServerState(raw: unknown, id: string): McpServerState {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,58}$/.test(id)) throw new Error(`mcpServers.${id} has an invalid server id`);
  if (!isRecord(raw)) throw new Error(`mcpServers.${id} must be a mapping`);
  if (raw.transport === 'stdio') {
    const allowed = new Set(['transport', 'command', 'args', 'env', 'cwd']);
    for (const key of Object.keys(raw)) if (!allowed.has(key)) throw new Error(`mcpServers.${id}.${key} is not a stdio setting`);
    if (typeof raw.command !== 'string' || raw.command.trim().length === 0) {
      throw new Error(`mcpServers.${id}.command must be a non-empty executable name`);
    }
    const server: McpServerState = {
      transport: 'stdio',
      command: raw.command,
      args: stringArray(raw.args, `mcpServers.${id}.args`),
      env: environmentReferences(raw.env, `mcpServers.${id}.env`),
    };
    if (raw.cwd !== undefined) {
      if (typeof raw.cwd !== 'string' || raw.cwd.length === 0) throw new Error(`mcpServers.${id}.cwd must be a non-empty path`);
      server.cwd = raw.cwd;
    }
    return server;
  }

  if (raw.transport === 'http' || raw.transport === 'sse') {
    const allowed = new Set(['transport', 'url', 'headers']);
    for (const key of Object.keys(raw)) if (!allowed.has(key)) throw new Error(`mcpServers.${id}.${key} is not an HTTP setting`);
    if (typeof raw.url !== 'string') throw new Error(`mcpServers.${id}.url must be a URL`);
    let url: URL;
    try {
      url = new URL(raw.url);
    } catch {
      throw new Error(`mcpServers.${id}.url must be a valid HTTP or HTTPS URL`);
    }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
      throw new Error(`mcpServers.${id}.url must use HTTP(S) and must not contain credentials`);
    }
    return {
      transport: raw.transport,
      url: url.toString(),
      headers: environmentReferences(raw.headers, `mcpServers.${id}.headers`, (name) => /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)),
    };
  }

  throw new Error(`mcpServers.${id}.transport must be stdio, http, or sse`);
}

export function getSettingsPath(): string {
  return SETTINGS_FILE;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stringArray(value: unknown, where: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`${where} must be a list of strings`);
  }
  return value as string[];
}

/**
 * Validates the raw option bag handed to a provider's runtime package.
 *
 * The values are not Ranite's to interpret, but they are Ranite's to refuse when
 * malformed: a mapping of bounded size, with no prototype keys, because these
 * objects reach `import()` arguments and request headers.
 */
function providerOptions(value: unknown, where: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${where} must be a mapping of option names to values`);
  const serialized = JSON.stringify(value);
  if (serialized.length > 16_000) throw new Error(`${where} must serialize under 16000 characters (got ${serialized.length}).`);
  const clone = (node: Record<string, unknown>, path: string): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(node)) {
      if (['__proto__', 'prototype', 'constructor'].includes(key)) {
        throw new Error(`${path}.${key} is not an allowed option name.`);
      }
      if (item !== null && typeof item === 'object' && !Array.isArray(item))
        out[key] = clone(item as Record<string, unknown>, `${path}.${key}`);
      else if (Array.isArray(item))
        out[key] = item.map((entry) => (typeof entry === 'object' && entry !== null ? JSON.parse(JSON.stringify(entry)) : entry));
      else out[key] = item;
    }
    return out;
  };
  return clone(value, where);
}

function parseProviderState(raw: unknown, id: string): ProviderState {
  if (!isRecord(raw)) throw new Error(`providers.${id} must be a mapping`);
  for (const key of Object.keys(raw)) {
    if (!KNOWN_PROVIDER_KEYS.has(key)) {
      throw new Error(`providers.${id}.${key} is not a setting ranite knows (known: ${[...KNOWN_PROVIDER_KEYS].join(', ')})`);
    }
  }
  const state: ProviderState = {
    enabled: raw.enabled === undefined ? true : raw.enabled === true,
    keys: stringArray(raw.keys, `providers.${id}.keys`),
  };
  if (raw.models !== undefined) {
    const models = stringArray(raw.models, `providers.${id}.models`);
    if (models.length > 512 || models.some((model) => !model.trim() || model.length > 512)) {
      throw new Error(`providers.${id}.models must contain at most 512 non-empty model IDs under 512 characters each.`);
    }
    state.models = [...new Set(models.map((model) => model.trim()))];
  }
  if (typeof raw.url === 'string' && raw.url.length > 0) state.url = raw.url;
  if (typeof raw.npm === 'string' && raw.npm.length > 0) state.npm = raw.npm;
  if (raw.options !== undefined) {
    const options = providerOptions(raw.options, `providers.${id}.options`);
    if (Object.keys(options).length > 0) state.options = options;
  }
  return state;
}

/**
 * True when something authenticates this provider.
 *
 * A key is the usual answer, but not the only one: a provider whose runtime
 * package signs requests itself (AWS SigV4) or reads a service account from the
 * environment (Google Vertex) needs no key, and the operator declares that by
 * giving the provider an `options` block. Without options and without a key the
 * provider is genuinely unconfigured.
 */
export function hasCredential(state: ProviderState | undefined): boolean {
  if (!state) return false;
  return state.keys.length > 0 || Object.keys(state.options ?? {}).length > 0;
}

/** Retains a model as a provider-specific choice without making it the default. */
export function rememberProviderModel(settings: SettingsStore, providerId: string, modelId: string): void {
  const provider = settings.providers[providerId];
  const normalized = modelId.trim();
  if (!provider || !normalized || provider.models?.includes(normalized)) return;
  if ((provider.models?.length ?? 0) >= 512) throw new Error(`Provider ${providerId} already has 512 saved model IDs.`);
  provider.models = [...(provider.models ?? []), normalized];
}

export function defaultSettings(): SettingsStore {
  return {
    providers: {},
    mcpServers: {},
    providerOrder: [],
    defaultProvider: '',
    defaultModel: '',
    approvalMode: 'workspace',
    backgroundTasks: [],
  };
}

/** Reads settings from disk, or returns defaults when the file is absent. */
export function loadSettings(): SettingsStore {
  let text: string;
  try {
    text = readFileSync(SETTINGS_FILE, 'utf8');
  } catch (error) {
    // Only a missing file means "defaults". A permissions or I/O failure must stay visible.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return defaultSettings();
    throw error;
  }
  const parsed: unknown = parseYaml(text);
  if (parsed === null || parsed === undefined) return defaultSettings();
  if (!isRecord(parsed)) throw new Error(`${SETTINGS_FILE} must be a mapping`);
  for (const key of Object.keys(parsed)) {
    if (!KNOWN_KEYS.has(key)) {
      throw new Error(`${key} is not a setting ranite knows (known: ${[...KNOWN_KEYS].join(', ')})`);
    }
  }

  const settings = defaultSettings();
  if (isRecord(parsed.providers)) {
    for (const [id, raw] of Object.entries(parsed.providers)) settings.providers[id] = parseProviderState(raw, id);
  }
  if (parsed.mcpServers !== undefined) {
    if (!isRecord(parsed.mcpServers)) throw new Error('mcpServers must be a mapping');
    for (const [id, raw] of Object.entries(parsed.mcpServers)) {
      settings.mcpServers[id] = parseMcpServerState(raw, id);
    }
  }
  settings.providerOrder = stringArray(parsed.providerOrder, 'providerOrder').filter((id) => id in settings.providers);
  for (const id of Object.keys(settings.providers)) {
    if (!settings.providerOrder.includes(id)) settings.providerOrder.push(id);
  }
  if (typeof parsed.defaultProvider === 'string') settings.defaultProvider = parsed.defaultProvider;
  if (typeof parsed.defaultModel === 'string') settings.defaultModel = parsed.defaultModel;
  if (parsed.reasoning !== undefined) {
    if (typeof parsed.reasoning !== 'string' || !/^[A-Za-z0-9:_-]{1,128}$/.test(parsed.reasoning)) {
      throw new Error('reasoning must be a valid model variant id');
    }
    settings.reasoning = parsed.reasoning;
  }
  if (parsed.showReasoning !== undefined) {
    if (typeof parsed.showReasoning !== 'boolean') throw new Error('showReasoning must be a boolean');
    settings.showReasoning = parsed.showReasoning;
  }
  if (parsed.theme !== undefined) {
    if (parsed.theme !== 'Dark' && parsed.theme !== 'Light' && parsed.theme !== 'System') {
      throw new Error('theme must be Dark, Light, or System');
    }
    settings.theme = parsed.theme;
  }
  if (parsed.approvalMode !== undefined) {
    if (parsed.approvalMode === 'ask') {
      // Migrate the original v1 approval mode to the folder-scoped default.
      settings.approvalMode = 'workspace';
    } else if (parsed.approvalMode === 'workspace' || parsed.approvalMode === 'auto-review' || parsed.approvalMode === 'full-access') {
      settings.approvalMode = parsed.approvalMode;
    } else throw new Error('approvalMode must be workspace, auto-review, or full-access');
  }
  if (parsed.autoReviewTimeoutSeconds !== undefined) {
    if (
      typeof parsed.autoReviewTimeoutSeconds !== 'number' ||
      !Number.isInteger(parsed.autoReviewTimeoutSeconds) ||
      parsed.autoReviewTimeoutSeconds < 5 ||
      parsed.autoReviewTimeoutSeconds > 600
    ) {
      throw new Error('autoReviewTimeoutSeconds must be a whole number of seconds between 5 and 600.');
    }
    settings.autoReviewTimeoutSeconds = parsed.autoReviewTimeoutSeconds;
  }
  if (parsed.backgroundTasks !== undefined) {
    if (!Array.isArray(parsed.backgroundTasks) || parsed.backgroundTasks.length > 256)
      throw new Error('backgroundTasks must be a list of up to 256 tasks.');
    settings.backgroundTasks = parsed.backgroundTasks.map(parseBackgroundTaskState);
    if (new Set(settings.backgroundTasks.map((task) => task.id)).size !== settings.backgroundTasks.length)
      throw new Error('backgroundTasks contains duplicate task ids.');
  }
  if (parsed.defaultWorkspaceRoot !== undefined) {
    if (
      typeof parsed.defaultWorkspaceRoot !== 'string' ||
      parsed.defaultWorkspaceRoot.length > 32_768 ||
      !isAbsolute(parsed.defaultWorkspaceRoot)
    )
      throw new Error('defaultWorkspaceRoot must be an absolute path.');
    settings.defaultWorkspaceRoot = parsed.defaultWorkspaceRoot;
  }
  if (parsed.telegram !== undefined) settings.telegram = parseTelegramSettings(parsed.telegram);
  return settings;
}

/** Writes settings atomically, so a crash cannot leave a half file. */
export function saveSettings(settings: SettingsStore): void {
  const ordered: Record<string, ProviderState> = {};
  for (const id of [...settings.providerOrder, ...Object.keys(settings.providers)]) {
    if (id in settings.providers) ordered[id] = settings.providers[id];
  }
  const document = {
    providers: ordered,
    mcpServers: settings.mcpServers,
    providerOrder: Object.keys(ordered),
    defaultProvider: settings.defaultProvider,
    defaultModel: settings.defaultModel,
    ...(settings.reasoning ? { reasoning: settings.reasoning } : {}),
    ...(settings.showReasoning !== undefined ? { showReasoning: settings.showReasoning } : {}),
    ...(settings.theme ? { theme: settings.theme } : {}),
    approvalMode: settings.approvalMode,
    ...(settings.autoReviewTimeoutSeconds === undefined ? {} : { autoReviewTimeoutSeconds: settings.autoReviewTimeoutSeconds }),
    backgroundTasks: settings.backgroundTasks,
    ...(settings.defaultWorkspaceRoot ? { defaultWorkspaceRoot: settings.defaultWorkspaceRoot } : {}),
    ...(settings.telegram ? { telegram: settings.telegram } : {}),
  };
  mkdirSync(dirname(SETTINGS_FILE), { recursive: true });
  const tempFile = `${SETTINGS_FILE}.tmp`;
  writeFileSync(tempFile, dumpYaml(document, { lineWidth: 120 }), 'utf8');
  // Provider entries hold API key material, so the file is owner-only like the
  // allowlist and the ledger. Note that on Windows `chmod` only toggles the read-only
  // attribute: the data directory's ACL is what actually governs access there.
  try {
    chmodSync(tempFile, 0o600);
  } catch {
    /* Windows uses the directory ACL. */
  }
  renameSync(tempFile, SETTINGS_FILE);
}

export function parseBackgroundTaskState(raw: unknown): BackgroundTaskState {
  if (!isRecord(raw)) throw new Error('A background task must be a mapping.');
  const allowed = new Set(['id', 'name', 'enabled', 'workspaceRoot', 'instruction', 'trigger']);
  for (const key of Object.keys(raw)) if (!allowed.has(key)) throw new Error(`background task ${key} is not a supported setting.`);
  if (typeof raw.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(raw.id))
    throw new Error('Background task id must use 1-64 letters, digits, underscores, or dashes.');
  if (typeof raw.name !== 'string' || !raw.name.trim() || raw.name.length > 128)
    throw new Error('Background task name must use 1-128 characters.');
  if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') throw new Error('Background task enabled must be a boolean.');
  if (typeof raw.workspaceRoot !== 'string' || raw.workspaceRoot.length > 32_768 || !isAbsolute(raw.workspaceRoot))
    throw new Error('Background task workspaceRoot must be an absolute path.');
  if (typeof raw.instruction !== 'string' || !raw.instruction.trim() || raw.instruction.length > 16_000)
    throw new Error('Background task instruction must use 1-16000 characters.');
  if (!isRecord(raw.trigger) || Object.keys(raw.trigger).some((key) => key !== 'adapter' && key !== 'options'))
    throw new Error('Background task trigger must contain adapter and options.');
  if (typeof raw.trigger.adapter !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(raw.trigger.adapter))
    throw new Error('Background task trigger adapter is invalid.');
  if (!isRecord(raw.trigger.options) || JSON.stringify(raw.trigger.options).length > 16_000)
    throw new Error('Background task trigger options must be a mapping under 16000 characters.');
  return {
    id: raw.id,
    name: raw.name,
    enabled: raw.enabled ?? true,
    workspaceRoot: raw.workspaceRoot,
    instruction: raw.instruction,
    trigger: { adapter: raw.trigger.adapter, options: raw.trigger.options },
  };
}

export function parseTelegramSettings(raw: unknown): TelegramSettings {
  if (!isRecord(raw) || Object.keys(raw).some((key) => !['enabled', 'tokenEnv', 'workspaceRoot', 'chatId', 'userId'].includes(key)))
    throw new Error('telegram contains an unsupported setting.');
  if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') throw new Error('telegram.enabled must be a boolean.');
  if (typeof raw.tokenEnv !== 'string' || !isEnvironmentName(raw.tokenEnv))
    throw new Error('telegram.tokenEnv must name an environment variable, not contain a token.');
  if (typeof raw.workspaceRoot !== 'string' || !isAbsolute(raw.workspaceRoot))
    throw new Error('telegram.workspaceRoot must be an absolute path.');
  if ((raw.chatId === undefined) !== (raw.userId === undefined)) throw new Error('telegram chatId and userId must be paired together.');
  if (raw.chatId !== undefined && (typeof raw.chatId !== 'string' || !/^\d{1,20}$/.test(raw.chatId)))
    throw new Error('telegram.chatId must be a private chat id.');
  if (raw.userId !== undefined && (typeof raw.userId !== 'string' || !/^\d{1,20}$/.test(raw.userId)))
    throw new Error('telegram.userId is invalid.');
  return {
    enabled: raw.enabled ?? true,
    tokenEnv: raw.tokenEnv,
    workspaceRoot: raw.workspaceRoot,
    ...(raw.chatId === undefined ? {} : { chatId: raw.chatId as string, userId: raw.userId as string }),
  };
}
