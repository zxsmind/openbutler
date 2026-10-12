#!/usr/bin/env node
/**
 * Ranite CLI.
 *
 * Every output goes through the UI kit so piped output stays readable and
 * interactive output stays animated.
 */
import { parseArgs, questionFrom, type Parsed } from './cli/args.js';
import { existsSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import { getDaemonStatus, requestHost, restartDaemon, runDaemonProcess, startDaemon, stopDaemon } from './daemon.js';
import {
  autostartDescription,
  installAutostart,
  isAutostartInstalled,
  refreshAutostartEnv,
  uninstallAutostart,
} from './daemon-autostart.js';
import { connectDaemonSession } from './daemon-client.js';
import { parseRetentionDuration, selectFilesToPrune } from './retention.js';
import { getRaniteVersion } from './version.js';
import { getCatalogIndex } from './provider/catalog.js';
import { listToolCapableModels, listSupportedPackages, providerIsConfigured } from './provider/registry.js';
import { getSettingsPath, loadSettings, parseTelegramSettings, saveSettings } from './settings.js';
import { getDataPath } from './paths.js';
import type { TelegramStatus } from './telegram.js';
import {
  TELEGRAM_SETUP_TEST_MESSAGE,
  TelegramSetupError,
  isPlausibleBotToken,
  persistTokenEnv,
  removeTokenEnv,
  verifyBotToken,
  waitForPairing,
  waitForSettledState,
} from './telegram-setup.js';
import type { McpServerState } from './settings.js';
import { defaultModelIsUsable, readiness, summarizeProviders } from './cli/config-edit.js';
import { runUninstall } from './uninstall.js';
import * as ui from './cli/ui.js';

import type { AgentSessionRuntimeView } from './agent-session.js';
import type { ToolCallRequest } from './tools/registry.js';
import type { McpServerRequest } from './tools/mcp.js';

/**
 * Rows shown by `--list-models` before it asks the user to narrow things down.
 * Large enough to scan a provider's worth, small enough that a mistyped filter
 * does not print thousands of lines into a terminal.
 */
const DEFAULT_MODEL_LIMIT = 200;

function usage(): void {
  ui.line('Usage  ranite [options]');
  ui.line();
  ui.line('Commands:');
  printHelpRows([
    ['ranite', 'Open an interactive terminal session', '[default]'],
    ['ranite setup', 'First-run wizard. Saves once at the end.'],
    ['ranite config', 'Show the current settings.'],
    [
      'ranite permissions [workspace|auto-review|full-access]',
      'Choose the tool approval mode; --review-timeout <seconds> tunes auto-review.',
    ],
    ['ranite daemon', 'Start, inspect, stop, or install the background host.'],
    ['ranite restart', 'Restart the background host and reconnect open sessions.'],
    ['ranite mcp', 'Manage global MCP servers.'],
    ['ranite tasks', 'List, add, run, and open explicitly configured background tasks.'],
    ['ranite telegram', 'Configure and pair the owner Telegram channel.'],
    ['ranite events', 'Inspect the durable event ledger.'],
    ['ranite actions', 'Inspect the durable tool action ledger.'],
    ['ranite sessions index', 'Build or refresh the derived session search index (--rebuild to redo it).'],
    ['ranite sessions prune', 'Delete session files older than an explicit cutoff (needs --yes).'],
    ['ranite workspace default <path>', 'Choose the workspace used by bare Ranite launches.'],
    ['ranite skills', 'List global and active-workspace Agent Skills.'],
    ['ranite about', 'Version, runtime, configuration paths.'],
    ['ranite uninstall', 'Remove the installed program. Keeps data; --purge removes it too.'],
  ]);
  ui.line();
  ui.line('Options:');
  printHelpRows([
    ['--workspace <path>', 'Select this client’s workspace scope for the shared custodian.', '[string]'],
    ['--c "<request>"', 'Ask the agent; it can select available tools.', '[string]'],
    ['--list-models', 'List models that can call tools. --filter, --limit, --provider.', '[boolean]'],
    ['--version', 'Print the installed version.', '[boolean]'],
    ['-h, --help', 'Show all commands.', '[boolean]'],
  ]);
  ui.line();
  ui.info(`Settings live in ${getSettingsPath()}.`);
  ui.line();
}

function printHelpRows(rows: Array<[string, string, string?]>) {
  const nameWidth = Math.max(...rows.map(([name]) => name.length));
  const descWidth = Math.max(...rows.map(([, description]) => description.length));
  for (const [name, description, tag = ''] of rows) {
    ui.line(`  ${name.padEnd(nameWidth)}  ${description.padEnd(descWidth)}${tag ? `  ${tag}` : ''}`);
  }
}

async function runConfig(): Promise<void> {
  const settings = loadSettings();
  showMcpServers(settings);
  ui.kv('Default workspace', settings.defaultWorkspaceRoot ?? '(choose when opening Ranite)');
  ui.kv('Tool access', formatApprovalMode(settings.approvalMode));
  if (Object.keys(settings.providers).length === 0) {
    ui.section('Providers');
    ui.line();
    ui.warn('No provider is configured.');
    ui.info('Set one up: ranite setup');
    return;
  }
  /* Loaded before summarizing: a tool-capable count taken with no catalog is
     zero, and zero is a claim about the provider rather than about the cache. */
  await getCatalogIndex();
  const summaries = summarizeProviders(settings);
  ui.section('Providers');
  ui.table(
    ['PROVIDER', 'STATE', 'KEYS', 'TOOLS', 'DEFAULT', 'KIND'],
    summaries.map((entry) => [
      entry.isDefault ? `${entry.id} *` : entry.id,
      entry.enabled ? 'on' : 'off',
      String(entry.keyCount),
      entry.toolCapableCount === null ? 'unknown' : String(entry.toolCapableCount),
      settings.defaultProvider === entry.id ? settings.defaultModel || '(none)' : '',
      entry.custom ? 'custom' : 'catalog',
    ]),
  );
  ui.line();
  ui.kv('Default', settings.defaultProvider ? `${settings.defaultProvider} / ${settings.defaultModel || '(none)'}` : '(none)');
  ui.kv('Reasoning', settings.reasoning ?? 'auto');
  ui.kv('Show reasoning', settings.showReasoning ? 'on' : 'off');
  ui.line();
  const report = readiness(settings);
  if (report.ready) ui.success('Ready to run.');
  else for (const problem of report.problems) ui.failure(problem);
  for (const hint of report.hints) ui.info(hint);
  if (!defaultModelIsUsable(settings)) ui.info('Change the default model: ranite setup');
}

async function runPermissions(parsed: Parsed): Promise<void> {
  const requestedMode = parsed.words[0] ?? '';
  if (requestedMode && !['ask', 'workspace', 'auto-review', 'full-access'].includes(requestedMode)) {
    throw new Error('Usage: ranite permissions [workspace|auto-review|full-access] [--review-timeout <seconds>]');
  }
  const timeoutFlag = parsed.flags.get('review-timeout');
  let timeoutSeconds: number | undefined;
  if (timeoutFlag !== undefined) {
    const candidate = Number(timeoutFlag);
    if (!Number.isInteger(candidate) || candidate < 5 || candidate > 600) {
      throw new Error('--review-timeout must be a whole number of seconds between 5 and 600.');
    }
    timeoutSeconds = candidate;
  }

  const settings = loadSettings();
  if (timeoutSeconds !== undefined) {
    settings.autoReviewTimeoutSeconds = timeoutSeconds;
    saveSettings(settings);
  }
  if (requestedMode) {
    settings.approvalMode =
      requestedMode === 'ask' || requestedMode === 'workspace'
        ? 'workspace'
        : requestedMode === 'auto-review'
          ? 'auto-review'
          : 'full-access';
    const activeHost = await getDaemonStatus();
    if (activeHost?.legacy) {
      saveSettings(settings);
      ui.warn('Saved for the next host start. Stop the older host with `ranite daemon stop`, then reopen Ranite.');
    } else if (activeHost) await requestHost('permissions.set-mode', { mode: settings.approvalMode });
    else saveSettings(settings);
  }

  ui.kv('Current mode', formatApprovalMode(settings.approvalMode));
  ui.kv(
    'Auto-review timeout',
    settings.autoReviewTimeoutSeconds === undefined ? '15 seconds (default)' : `${settings.autoReviewTimeoutSeconds} seconds`,
  );
  ui.info('Workspace paths run without prompts. Auto-review asks the selected model about actions outside the workspace.');
  ui.info('Use `ranite permissions full-access` to disable tool permission prompts.');
  if (requestedMode) ui.success(`Saved ${formatApprovalMode(settings.approvalMode)} mode.`);
  if (timeoutSeconds !== undefined) ui.success(`Auto-review timeout set to ${timeoutSeconds} seconds.`);
  await showAutoReviewHistory();
}

/** Surfaces the recorded auto-review verdicts so the mode is observable in production. */
async function showAutoReviewHistory(): Promise<void> {
  const path = getDataPath('state.db');
  if (!existsSync(path)) return;
  const { ActivityLedger } = await import('./activity-ledger.js');
  const ledger = new ActivityLedger(path, { readOnly: true });
  try {
    const summary = ledger.autoReviewSummary();
    if (summary.reviewed + summary.unavailable === 0) return;
    ui.line();
    ui.section('Auto-review history');
    ui.kv('Decisions', `${summary.allow} allow · ${summary.deny} deny · ${summary.escalate} escalate`);
    if (summary.unavailable > 0) {
      const breakdown = Object.entries(summary.unavailableByCode)
        .map(([code, count]) => `${code} ${count}`)
        .join(' · ');
      ui.kv('Needed you', `${summary.unavailable} (${breakdown})`);
    }
  } finally {
    ledger.close();
  }
}

function formatApprovalMode(mode: ReturnType<typeof loadSettings>['approvalMode']): string {
  if (mode === 'auto-review') return 'Approve for me (Auto-review outside workspace)';
  if (mode === 'full-access') return 'Full access (no permission prompts)';
  return 'Workspace (default)';
}

function runWorkspaceCommand(parsed: Parsed): void {
  if (parsed.words[0] !== 'default' || parsed.words.length > 2) throw new Error('Usage: ranite workspace default [path]');
  const settings = loadSettings();
  const path = parsed.words[1];
  if (path === undefined) {
    ui.kv('Default workspace', settings.defaultWorkspaceRoot ?? '(none; bare Ranite uses the launch directory)');
    return;
  }
  const root = resolveWorkspace(path);
  settings.defaultWorkspaceRoot = root;
  saveSettings(settings);
  ui.success(`Bare Ranite launches will use ${root}.`);
}

function resolveWorkspace(path: string): string {
  const requested = path.trim();
  if (!requested) throw new Error('Workspace path cannot be empty.');
  const expanded = requested === '~' ? homedir() : requested.replace(/^~(?=[/\\])/, homedir());
  const absolutePath = isAbsolute(expanded) ? expanded : resolve(process.cwd(), expanded);
  const workspaceRoot = realpathSync(absolutePath);
  if (!statSync(workspaceRoot).isDirectory()) throw new Error(`Workspace path is not a directory: ${workspaceRoot}`);
  return workspaceRoot;
}

async function resolveSessionWorkspace(path: string | undefined): Promise<string> {
  if (path !== undefined) return resolveWorkspace(path);
  const configured = loadSettings().defaultWorkspaceRoot;
  if (configured) return resolveWorkspace(configured);
  /* The directory the client was launched in is the scope the owner meant, so
     it needs no question: work there runs without permission prompts. */
  return resolveWorkspace(process.cwd());
}

function showMcpServers(settings: ReturnType<typeof loadSettings>): void {
  ui.section('MCP servers');
  const servers = Object.entries(settings.mcpServers);
  if (servers.length === 0) ui.info('No MCP servers configured.');
  else {
    ui.table(
      ['SERVER', 'TRANSPORT', 'ENDPOINT'],
      servers.map(([id, server]) => [
        id,
        server.transport,
        server.transport === 'stdio' ? [server.command, ...server.args].join(' ') : server.url,
      ]),
    );
  }
  ui.info('Manage global servers with ranite mcp. Credentials are environment-variable references, not saved values.');
  ui.line();
}

async function runMcpManager(requestedAction = ''): Promise<void> {
  const settings = loadSettings();
  if (requestedAction && !['list', 'add', 'remove'].includes(requestedAction)) {
    throw new Error('Usage: ranite mcp [list|add|remove]');
  }
  if (requestedAction === 'list' || !process.stdin.isTTY) {
    showMcpServers(settings);
    if (requestedAction !== 'list') ui.info('Use an interactive terminal with ranite mcp to add or remove servers.');
    return;
  }

  const { confirm, input, select } = await import('@inquirer/prompts');
  let action = requestedAction;
  for (;;) {
    if (!action) {
      action = await select({
        message: 'Global MCP servers',
        choices: [
          { value: 'list', name: 'List configured servers' },
          { value: 'add', name: 'Add a server' },
          { value: 'remove', name: 'Remove a server' },
          { value: 'done', name: 'Done' },
        ],
      });
    }
    if (action === 'done') return;
    if (action === 'list') showMcpServers(settings);
    if (action === 'add') {
      const id = await input({
        message: 'Server id (letters, digits, underscore, dash)',
        validate: (value) =>
          /^[A-Za-z0-9][A-Za-z0-9_-]{0,58}$/.test(value) && !(value in settings.mcpServers)
            ? true
            : 'Use a unique id with 1-59 letters, digits, underscores, or dashes.',
      });
      const transport = await select({
        message: 'Transport',
        choices: [
          { value: 'stdio', name: 'Local process (stdio)' },
          { value: 'http', name: 'Streamable HTTP' },
          { value: 'sse', name: 'Server-Sent Events (SSE)' },
        ],
      });
      let server: McpServerState;
      if (transport === 'stdio') {
        const command = await input({ message: 'Executable command', validate: (value) => (value.trim() ? true : 'Command is required.') });
        const argsText = await input({
          message: 'Arguments as a JSON string array',
          default: '[]',
          validate: (value) => (parseMcpStringArray(value) === null ? 'Enter a JSON array of strings, for example ["--stdio"].' : true),
        });
        const envText = await input({
          message: 'Environment name to host-variable references as JSON (values are never saved), or {}',
          default: '{}',
          validate: (value) =>
            parseMcpEnvReferences(value, false) === null
              ? 'Enter a JSON object mapping server env names to host environment variable names.'
              : true,
        });
        const cwd = await input({ message: 'Working directory (optional)', default: process.cwd() });
        server = {
          transport: 'stdio',
          command: command.trim(),
          args: parseMcpStringArray(argsText)!,
          env: parseMcpEnvReferences(envText, false)!,
          ...(cwd.trim() ? { cwd: cwd.trim() } : {}),
        };
      } else {
        const url = await input({
          message: 'HTTP(S) endpoint URL',
          validate: (value) => (isValidMcpUrl(value) ? true : 'Enter an HTTP or HTTPS URL without embedded credentials.'),
        });
        const headersText = await input({
          message: 'Header name to host-variable references as JSON (values are never saved), or {}',
          default: '{}',
          validate: (value) =>
            parseMcpEnvReferences(value, true) === null
              ? 'Enter a JSON object mapping header names to host environment variable names.'
              : true,
        });
        server = {
          transport,
          url: new URL(url).toString(),
          headers: parseMcpEnvReferences(headersText, true)!,
        };
      }
      settings.mcpServers[id] = server;
      saveSettings(settings);
      ui.success('Saved global MCP server ' + id + '. Ranite will ask before connecting at session start.');
    } else if (action === 'remove') {
      const ids = Object.keys(settings.mcpServers);
      if (ids.length === 0) ui.info('No MCP servers are configured.');
      else {
        const id = await select({
          message: 'Choose a server to remove',
          choices: ids.map((serverId) => ({ value: serverId, name: serverId })),
        });
        if (await confirm({ message: 'Remove global MCP server ' + id + '?', default: false })) {
          delete settings.mcpServers[id];
          saveSettings(settings);
          ui.success('Removed MCP server ' + id + '.');
        }
      }
    }
    action = '';
  }
}

function parseMcpStringArray(value: string): string[] | null {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every((item) => typeof item === 'string') ? parsed : null;
  } catch {
    return null;
  }
}

function parseMcpEnvReferences(value: string, headers: boolean): Record<string, string> | null {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const targetName = headers ? /^[!#$%&'*+.^_\x60|~0-9A-Za-z-]+$/ : /^[A-Za-z_][A-Za-z0-9_]*$/;
    const entries = Object.entries(parsed);
    return entries.every(
      ([key, env]) =>
        !['__proto__', 'prototype', 'constructor'].includes(key) &&
        targetName.test(key) &&
        typeof env === 'string' &&
        /^[A-Za-z_][A-Za-z0-9_]*$/.test(env),
    )
      ? (Object.fromEntries(entries) as Record<string, string>)
      : null;
  } catch {
    return null;
  }
}

function isValidMcpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password;
  } catch {
    return false;
  }
}

async function runListModels(parsed: Parsed): Promise<void> {
  const settings = loadSettings();
  const configured = settings.providerOrder.filter((id) => id in settings.providers);
  if (configured.length === 0) {
    ui.warn('Configure a provider first: ranite setup');
    return;
  }
  await getCatalogIndex();
  const rows = parsed.flags.has('provider') ? [parsed.flags.get('provider')!] : configured;
  const models = listToolCapableModels(rows, settings.providers);
  ui.section(`Models that can call tools (${models.length})`);

  const filter = (parsed.flags.get('filter') ?? '').toLowerCase();
  const shown = filter ? models.filter((entry) => `${entry.providerId}/${entry.model}`.toLowerCase().includes(filter)) : models;

  const rawLimit = Number(parsed.flags.get('limit') ?? DEFAULT_MODEL_LIMIT);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.floor(rawLimit) : DEFAULT_MODEL_LIMIT;

  ui.table(
    ['PROVIDER', 'MODEL'],
    shown.slice(0, limit).map((entry) => [entry.providerId, entry.model]),
  );
  if (shown.length > limit) {
    ui.line();
    ui.info(`${shown.length} models match; showing ${limit}. Narrow it with --filter <term>, or raise the cap with --limit <n>.`);
  }
}

async function runSkills(parsed: Parsed): Promise<void> {
  const { discoverSkills, getSkillRoots } = await import('./skills.js');
  const workspaceRoot = parsed.flags.get('workspace')
    ? resolveWorkspace(parsed.flags.get('workspace')!)
    : (loadSettings().defaultWorkspaceRoot ?? getDataPath('custodian'));
  const skills = discoverSkills(workspaceRoot);

  if (skills.length === 0) {
    ui.info('No Agent Skills found.');
    for (const root of getSkillRoots(workspaceRoot)) ui.kv(root.scope, root.path);
    ui.info('Add a skill-name/SKILL.md with Agent Skills frontmatter.');
    return;
  }
  ui.table(
    ['NAME', 'SCOPE', 'DESCRIPTION', 'SKILL FILE'],
    skills.map((skill) => [skill.name, skill.scope, skill.description, skill.filePath]),
  );
}

async function defaultModelReady(): Promise<boolean> {
  const settings = loadSettings();
  const providerId = settings.defaultProvider;
  const modelId = settings.defaultModel;
  const provider = settings.providers[providerId];
  if (!providerId || !modelId || !provider?.enabled || !providerIsConfigured(providerId, provider)) return false;

  if (!provider.npm) {
    try {
      await getCatalogIndex();
    } catch {
      return false;
    }
  }
  return defaultModelIsUsable(settings);
}

async function runQuestion(question: string, workspaceRoot: string): Promise<void> {
  if (!(await defaultModelReady())) throw new Error('Configure a tool-capable default model first: ranite setup');

  await startDaemon();
  const controller = await connectDaemonSession(workspaceRoot, approveMcpServer, { isolatedSession: true });
  const runtime = controller.runtime;
  ui.section('Ranite agent');
  ui.kv('Model', `${runtime.modelName} / ${runtime.modelId}`);
  ui.info(`Your request, tool definitions, and approved tool results will be sent to ${runtime.modelName}.`);

  let runStarted = false;
  let finished = false;
  let printedText = false;
  let finish!: () => void;
  const done = new Promise<void>((resolveDone) => {
    finish = resolveDone;
  });
  const assistantTextByIndex = new Map<number, string>();
  const toolDoneByIndex = new Map<number, boolean>();
  const promptedApprovalIds = new Set<string>();
  const promptedQuestionIds = new Set<string>();
  let visibleNoticeCount = 0;

  const onSnapshot = () => {
    const snapshot = controller.getSnapshot();
    if (snapshot.busy) runStarted = true;
    const notices = snapshot.session.entries.filter((entry) => entry.kind === 'notice');
    for (const notice of notices.slice(visibleNoticeCount)) if (notice.kind === 'notice') ui.warn(notice.text);
    visibleNoticeCount = notices.length;

    for (const [index, entry] of snapshot.session.entries.entries()) {
      if (entry.kind === 'assistant') {
        const previous = assistantTextByIndex.get(index) ?? '';
        if (entry.text.startsWith(previous)) {
          const delta = entry.text.slice(previous.length);
          if (delta) process.stdout.write(delta);
        } else if (entry.text) {
          if (printedText) process.stdout.write('\n');
          process.stdout.write(entry.text);
        }
        if (entry.text) printedText = true;
        assistantTextByIndex.set(index, entry.text);
      } else if (entry.kind === 'tool') {
        if (entry.preparing) continue;
        const wasDone = toolDoneByIndex.get(index);
        if (wasDone === undefined) {
          if (printedText) process.stdout.write('\n\n');
          ui.section('Tool');
          ui.line(entry.command);
          if (!entry.running) ui.line(entry.result);
        } else if (!wasDone && !entry.running) {
          ui.line(entry.result);
        }
        toolDoneByIndex.set(index, entry.running !== true);
      }
    }

    const pending = snapshot.pendingApproval;
    const approvalId = snapshot.pendingApprovalId;
    if (pending && approvalId && !promptedApprovalIds.has(approvalId)) {
      promptedApprovalIds.add(approvalId);
      void approveToolCall(pending, runtime)
        .then((allowed) => {
          controller.approveToolCall(allowed ? 'allow' : 'deny', approvalId);
        })
        .catch((error: unknown) => {
          ui.warn(`Approval prompt failed: ${error instanceof Error ? error.message : String(error)}`);
          controller.stop();
        });
    }

    const pendingQuestion = snapshot.pendingQuestion;
    if (pendingQuestion && !promptedQuestionIds.has(pendingQuestion.id)) {
      promptedQuestionIds.add(pendingQuestion.id);
      void answerQuestionPrompt(pendingQuestion)
        .then((answer) => {
          controller.answerQuestion(answer, pendingQuestion.id);
        })
        .catch((error: unknown) => {
          ui.warn(`Question prompt failed: ${error instanceof Error ? error.message : String(error)}`);
          controller.answerQuestion(null, pendingQuestion.id);
        });
    }

    if (runStarted && !snapshot.busy && !finished) {
      finished = true;
      if (printedText) process.stdout.write('\n');
      finish();
    }
  };

  const unsubscribe = controller.subscribe(onSnapshot);
  const startTimeout = setTimeout(() => {
    if (runStarted || finished) return;
    onSnapshot();
    if (!runStarted && !finished) {
      finished = true;
      ui.failure('The background host did not start the one-shot run.');
      finish();
    }
  }, 5_000);
  const onInterrupt = () => {
    if (finished) return;
    controller.stop();
    finished = true;
    finish();
  };
  process.once('SIGINT', onInterrupt);

  try {
    onSnapshot();
    await controller.sendMessage(
      { text: question, images: [] },
      {
        reasoningVariantId: runtime.reasoningVariants.some((variant) => variant.id === runtime.reasoningDefault)
          ? runtime.reasoningDefault
          : 'auto',
        showReasoning: loadSettings().showReasoning === true,
      },
    );
    await done;
  } finally {
    clearTimeout(startTimeout);
    process.off('SIGINT', onInterrupt);
    unsubscribe();
    await controller.flushSave();
    await controller.close();
  }
}

async function runSession(workspaceRoot: string): Promise<void> {
  if (!(await defaultModelReady())) {
    const { runSetup } = await import('./cli/setup.js');
    if (!(await runSetup())) return;
    if (!(await defaultModelReady())) return;
  }

  const { isMemoryEmbeddingModelPrepared } = await import('./memory-index.js');
  if (!(await isMemoryEmbeddingModelPrepared())) {
    const { prepareLocalMemoryModel } = await import('./cli/setup.js');
    if (!(await prepareLocalMemoryModel())) return;
  }

  await startDaemon();
  const controller = await connectDaemonSession(workspaceRoot, approveMcpServer, { custodian: true });
  try {
    const { runTerminalSession } = await import('./cli/terminal-session.js');
    await runTerminalSession(controller);
  } finally {
    try {
      await controller.flushSave();
    } catch {
      /* the host keeps its own save error in the session */
    }
    await controller.close();
  }
}

async function approveMcpServer(request: McpServerRequest): Promise<boolean> {
  if (!process.stdin.isTTY) {
    ui.warn(`No interactive terminal is available; MCP server ${request.id} was not started.`);
    return false;
  }
  ui.section(`MCP server: ${request.id}`);
  showMcpServerDetails(request);
  ui.warn('The server may provide tools. Each tool call will be shown and approved separately.');
  const { confirm } = await import('@inquirer/prompts');
  return confirm({ message: 'Connect to this MCP server?', default: false });
}

function showMcpServerDetails(request: McpServerRequest): void {
  ui.kv('Transport', request.transport);
  if (request.command) ui.kv('Executable', request.command);
  if (request.args) ui.kv('Arguments', JSON.stringify(request.args));
  if (request.cwd) ui.kv('Directory', request.cwd);
  if (request.env && Object.keys(request.env).length > 0) ui.kv('Environment refs', JSON.stringify(request.env));
  if (request.url) ui.kv('URL', request.url);
  if (request.headers && Object.keys(request.headers).length > 0) ui.kv('Header refs', JSON.stringify(request.headers));
}

async function approveToolCall(request: ToolCallRequest, runtime: AgentSessionRuntimeView): Promise<boolean> {
  if (!process.stdin.isTTY) {
    ui.warn(`No interactive terminal is available; ${request.providerId}/${request.name} was not called.`);
    return false;
  }
  ui.section(`Tool request: ${request.providerId}/${request.name}`);
  if (request.providerId === 'host' && request.name === 'execute_command') {
    ui.kv('Working directory', typeof request.input.cwd === 'string' ? request.input.cwd : runtime.workspaceRoot);
  }
  if (request.providerId === 'host' && request.name === 'mcp_manage') {
    const action = typeof request.input.action === 'string' ? request.input.action : '';
    const serverId = typeof request.input.serverId === 'string' ? request.input.serverId : '';
    if (action === 'add' && typeof request.input.config === 'object' && request.input.config !== null) {
      ui.kv('Global settings', getSettingsPath());
    } else if (serverId && ['connect', 'disconnect', 'remove'].includes(action)) {
      const config = loadSettings().mcpServers[serverId];
      if (config) {
        showMcpServerDetails(
          config.transport === 'stdio'
            ? {
                id: serverId,
                transport: 'stdio',
                command: config.command,
                args: config.args,
                env: config.env,
                ...(config.cwd ? { cwd: config.cwd } : {}),
              }
            : { id: serverId, transport: config.transport, url: config.url, headers: config.headers },
        );
      }
    }
    if (action === 'remove') ui.warn('This removes the global MCP configuration and stops its active connection.');
  }
  ui.kv('Effects', JSON.stringify(request.effect));
  ui.line(JSON.stringify(request.input, null, 2));
  const mcpAction =
    request.providerId === 'host' && request.name === 'mcp_manage' && typeof request.input.action === 'string' ? request.input.action : '';
  ui.warn(
    request.providerId === 'host' && request.name === 'file_read'
      ? `File contents or image data will be sent to ${runtime.modelName} if you allow this read.`
      : request.providerId === 'host' && request.name === 'grep'
        ? `Matching lines from local files will be sent to ${runtime.modelName}.`
        : request.providerId === 'host' && (request.name === 'file_write' || request.name === 'file_edit')
          ? request.name === 'file_edit'
            ? 'This modifies an existing file in place.'
            : 'This replaces the entire file content.'
          : mcpAction === 'add' || mcpAction === 'connect'
            ? 'Ranite will start or contact this MCP server. It receives the configured environment variables; its tools require separate approvals.'
            : mcpAction === 'disconnect' || mcpAction === 'remove'
              ? 'This changes the active global MCP connection and removes its tools from the agent.'
              : `Tool input goes to ${request.providerId}; its result will be sent to ${runtime.modelName}.`,
  );
  const { select } = await import('@inquirer/prompts');
  const decision = await select({
    message: 'Select an action',
    default: 'deny',
    choices: [
      { name: 'Allow once', value: 'allow' },
      { name: 'Deny', value: 'deny' },
      { name: 'Always allow this exact request in this workspace', value: 'always' },
    ],
  });
  if (decision === 'always') {
    try {
      const { rememberToolRequest } = await import('./tool-permissions.js');
      rememberToolRequest(runtime.workspaceRoot, request);
    } catch (error) {
      ui.warn(
        `Could not save the allowlist entry; this request will be allowed once. ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return decision !== 'deny';
}

async function answerQuestionPrompt(question: { id: string; question: string; options: string[] | null }): Promise<string | null> {
  if (!process.stdin.isTTY) return null;
  ui.section('Question from Ranite');
  ui.line(question.question);
  const { input, select } = await import('@inquirer/prompts');
  if (question.options && question.options.length > 0) {
    const choice = await select({
      message: 'Choose an answer',
      choices: [
        ...question.options.map((option) => ({ name: option, value: option })),
        { name: 'Type my own answer', value: '\u0000custom' },
      ],
    });
    if (choice !== '\u0000custom') return choice;
  }
  const typed = await input({ message: 'Your answer (leave empty to dismiss)' });
  const trimmed = typed.trim();
  return trimmed ? trimmed : null;
}

function runAbout(): void {
  ui.section('Ranite');
  ui.kv('Version', getRaniteVersion());
  ui.kv('Runtime', `${process.version} (${process.platform}/${process.arch})`);
  ui.kv('Settings', getSettingsPath());
  ui.kv('Runtime packages', listSupportedPackages().join(', '));
  ui.line();
}

async function runTasks(parsed: Parsed): Promise<void> {
  const action = parsed.words[0] ?? 'list';

  if (action === 'capabilities') {
    const { backgroundCapabilities } = await import('./tools/background.js');
    ui.line(JSON.stringify(backgroundCapabilities, null, 2));
    return;
  }
  const tasks = loadSettings().backgroundTasks;
  if (action === 'list') {
    if (tasks.length === 0) {
      ui.info('No background tasks are configured. Ask Ranite to create a task, or use `ranite tasks add <task.json>`.');
      return;
    }
    let runtime: Array<{ id: string; state: string; error?: string }> = [];
    if (await getDaemonStatus()) {
      const result = (await requestHost('background.manage', {
        input: { action: 'list' },
      })) as { runtime: typeof runtime };
      runtime = result.runtime;
    }
    ui.table(
      ['ID', 'NAME', 'STATE', 'TRIGGER', 'WORKSPACE'],
      tasks.map((task) => [
        task.id,
        task.name,
        runtime.find((item) => item.id === task.id)?.state ?? (task.enabled ? 'host stopped' : 'disabled'),
        task.trigger.adapter,
        task.workspaceRoot,
      ]),
    );
    for (const entry of runtime) if (entry.error) ui.warn(`${entry.id}: ${entry.error}`);
    return;
  }
  if (action === 'open') {
    if (!process.stdin.isTTY) throw new Error('Opening a task session requires an interactive terminal.');
    const id = parsed.words[1];
    const task = tasks.find((candidate) => candidate.id === id);
    if (!task) throw new Error('Background task does not exist.');
    await startDaemon();
    const client = await connectDaemonSession(task.workspaceRoot, approveMcpServer, { taskId: task.id });
    try {
      const { runTerminalSession } = await import('./cli/terminal-session.js');
      await runTerminalSession(client);
    } finally {
      await client.flushSave();
      await client.close();
    }
    return;
  }
  let input: Record<string, unknown>;
  if (action === 'add' || action === 'update') {
    const source = parsed.words[1];
    const inline = parsed.flags.get('json');
    if (!source && !inline) throw new Error('Provide a task JSON file or --json=<task object>.');
    if (source && statSync(resolve(source)).size > 64 * 1024) throw new Error('Task JSON file exceeded the 64 KB limit.');
    const task: unknown = JSON.parse(inline ?? readFileSync(resolve(source!), 'utf8'));
    input = { action, task };
  } else {
    if (!['remove', 'enable', 'disable', 'run'].includes(action))
      throw new Error('Usage: ranite tasks [list|capabilities|add|update|remove|enable|disable|run|open]');
    const taskId = parsed.words[1];
    if (!taskId) throw new Error('Provide a background task id.');
    input = { action, taskId };
  }
  let commandWorkspaceRoot: string | undefined;
  if (action === 'add' || action === 'update') {
    const taskInput = input.task;
    if (taskInput === null || typeof taskInput !== 'object' || Array.isArray(taskInput)) throw new Error('Task input must be an object.');
    const taskRecord = taskInput as Record<string, unknown>;
    const existingRoot = typeof taskRecord.id === 'string' ? tasks.find((task) => task.id === taskRecord.id)?.workspaceRoot : undefined;
    const chosenRoot =
      typeof taskRecord.workspaceRoot === 'string'
        ? taskRecord.workspaceRoot
        : (existingRoot ?? (await resolveSessionWorkspace(parsed.flags.get('workspace'))));
    commandWorkspaceRoot = resolveWorkspace(chosenRoot);
    input.task = { ...taskRecord, workspaceRoot: commandWorkspaceRoot };
  }
  await startDaemon();
  const result = await requestHost('background.manage', {
    input,
    ...(commandWorkspaceRoot ? { workspaceRoot: commandWorkspaceRoot } : {}),
  });
  ui.line(JSON.stringify(result, null, 2));
}

/**
 * Guided Telegram onboarding: token, workspace, host validation, pairing
 * with a wait loop, and a test message. Interactive by default; servers pass
 * `--token-env`/`--workspace` with the token already in the host environment.
 * The token value is never written to the settings file or printed.
 */
async function runTelegramSetup(parsed: Parsed): Promise<void> {
  const settings = loadSettings();
  let tokenEnv = parsed.flags.get('token-env');
  if (tokenEnv && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(tokenEnv)) throw new Error('--token-env must name an environment variable.');
  if (!tokenEnv) {
    if (!process.stdin.isTTY) throw new Error('Provide --token-env=<environment variable name> for non-interactive setup.');
    const { input } = await import('@inquirer/prompts');
    tokenEnv = await input({
      message: 'Environment variable containing the bot token',
      default: settings.telegram?.tokenEnv ?? 'TELEGRAM_BOT_TOKEN',
      validate: (value) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(value) || 'Enter an environment variable name.',
    });
  }
  // A pasted token may belong to a different bot than the stored pairing, so a
  // preserved chatId is only trusted when the token came from the environment.
  const hadEnvToken = (process.env[tokenEnv]?.trim() ?? '') !== '';
  let token = process.env[tokenEnv]?.trim() ?? '';
  if (!token) {
    if (!process.stdin.isTTY)
      throw new Error(
        `Set ${tokenEnv} in the environment, then re-run \`ranite telegram setup --token-env=${tokenEnv}\`. The value is never stored in the settings file.`,
      );
    const { confirm, password } = await import('@inquirer/prompts');
    ui.info('Open Telegram, message @BotFather, send /newbot, and copy the token it returns.');
    token = await password({
      message: 'Bot token',
      validate: (value) => isPlausibleBotToken(value) || 'That does not look like a bot token.',
    });
    await verifySetupToken(token);
    const persist =
      process.platform === 'win32'
        ? await confirm({ message: `Save the token to your user environment now with setx?`, default: true })
        : await confirm({ message: `Save the token to your user environment now (an export line in ~/.profile)?`, default: true });
    if (persist) {
      const { location } = await persistTokenEnv(tokenEnv, token);
      ui.success(`Token saved (${location}).`);
    } else {
      ui.info(`Set ${tokenEnv} in the login environment before starting the host, then run \`ranite telegram pair\`.`);
      return;
    }
    process.env[tokenEnv] = token;
  } else {
    await verifySetupToken(token, tokenEnv);
  }

  let workspaceRoot = parsed.flags.get('workspace');
  if (!workspaceRoot && !process.stdin.isTTY) {
    throw new Error('Non-interactive Telegram setup requires `--workspace <path>`.');
  } else if (!workspaceRoot) {
    const { input } = await import('@inquirer/prompts');
    workspaceRoot = await input({
      message: 'Default workspace for Telegram messages',
      default: realpathSync(process.cwd()),
      validate: (value) => {
        try {
          if (!statSync(realpathSync(value === '~' ? homedir() : value.replace(/^~(?=[/\\])/, homedir()))).isDirectory())
            return 'Not a directory.';
          return true;
        } catch {
          return 'Directory does not exist.';
        }
      },
    });
  }
  const expanded = workspaceRoot === '~' ? homedir() : workspaceRoot.replace(/^~(?=[/\\])/, homedir());
  let canonical: string;
  try {
    canonical = realpathSync(expanded);
  } catch {
    throw new Error(`Workspace directory does not exist: ${workspaceRoot}`);
  }
  if (!statSync(canonical).isDirectory()) throw new Error(`Workspace is not a directory: ${workspaceRoot}`);

  const paired = hadEnvToken && settings.telegram?.tokenEnv === tokenEnv ? settings.telegram : undefined;
  settings.telegram = parseTelegramSettings({
    enabled: true,
    tokenEnv: tokenEnv,
    workspaceRoot: canonical,
    ...(paired?.chatId ? { chatId: paired.chatId, userId: paired.userId } : {}),
  });
  saveSettings(settings);
  ui.success('Telegram settings saved. The bot token stays in the environment, never in the settings file.');
  if (process.platform === 'darwin' || process.platform === 'linux') {
    try {
      ui.info(refreshAutostartEnv().detail);
    } catch (error) {
      ui.warn(`Login startup wiring failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  let tg: TelegramStatus | null;
  if (!(await getDaemonStatus())) {
    await startDaemon();
  } else {
    await requestHost('settings.reload');
  }
  tg = await settledTelegramState();
  if (tg?.error && /missing in the host process/.test(tg.error)) {
    let restart = process.stdin.isTTY !== true;
    if (!restart) {
      const { confirm } = await import('@inquirer/prompts');
      restart = await confirm({
        message: 'The running host started before the variable existed, so it cannot see the token. Restart it now? Active runs stop.',
        default: true,
      });
    }
    if (!restart) {
      ui.info('Run `ranite restart`, then `ranite telegram pair`.');
      return;
    }
    if (process.stdin.isTTY !== true) ui.warn('Restarting the background host so it picks up the token; active runs stop.');
    await restartDaemon();
    tg = await settledTelegramState();
  }
  if (tg?.error) throw new Error(`Telegram failed to start: ${tg.error}`);
  if (!tg || tg.state !== 'polling') throw new Error('Telegram is not polling yet. Check `ranite telegram status` and try again.');
  ui.success(`Connected as @${tg.username ?? 'the bot'}.`);

  if (tg.paired) {
    ui.info('The owner chat is already paired.');
  } else {
    const pair = (await requestHost('telegram.pair')) as { code: string; expiresAt: string; username: string | null };
    ui.info('Open the bot and send this one-time pairing command:');
    ui.line(`/start ${pair.code}`);
    if (pair.username) ui.line(`https://t.me/${pair.username}?start=${pair.code}`);
    ui.kv('Expires', pair.expiresAt);
    if (!parsed.booleans.has('no-wait')) {
      const deadline = Date.parse(pair.expiresAt);
      let ticks = 0;
      const outcome = await waitForPairing(async () => ((await requestHost('telegram.status')) as TelegramStatus).paired === true, {
        deadlineMs: Number.isFinite(deadline) ? deadline : Date.now() + 5 * 60_000,
        onTick: (remaining) => {
          ticks += 1;
          if (ticks % 5 === 1) {
            const seconds = Math.max(0, Math.round(remaining / 1000));
            ui.info(`Waiting for the pairing message in Telegram (code expires in ${Math.floor(seconds / 60)}m ${seconds % 60}s)…`);
          }
        },
      });
      if (outcome === 'expired') {
        ui.warn('The pairing code expired. Run `ranite telegram pair` for a fresh one.');
        return;
      }
      ui.success('Owner chat paired.');
    } else {
      return;
    }
  }

  if (!parsed.booleans.has('skip-test')) {
    try {
      await requestHost('telegram.test', { message: TELEGRAM_SETUP_TEST_MESSAGE });
      ui.success('Test message delivered to the owner chat.');
    } catch (error) {
      ui.warn(`Paired, but the test message failed: ${error instanceof Error ? error.message : String(error)}`);
      ui.warn('If you rotated the bot token, run `ranite telegram reset` and set up again.');
    }
  }
  ui.info('Done. Message the bot any time; it shares one thread with this terminal.');
  ui.info('In the chat: /approvals re-sends pending approvals, /stop stops the current run.');
}

/** Read the settled Telegram state, waiting out a fresh host boot or restart. */
async function settledTelegramState(): Promise<TelegramStatus | null> {
  let latest: TelegramStatus | null = null;
  await waitForSettledState(async () => {
    latest = (await getDaemonStatus())?.telegram ?? null;
    if (!latest || latest.paired) return 'polling';
    if (latest.state === 'polling' || latest.state === 'error') return latest.state;
    return 'pending';
  });
  return latest;
}

/** Live token check with kind-aware failure handling for the setup flow. */
async function verifySetupToken(token: string, envName?: string): Promise<void> {
  try {
    const { username } = await verifyBotToken(token);
    ui.success(`Token belongs to @${username}.`);
  } catch (error) {
    if (error instanceof TelegramSetupError && error.kind === 'invalid')
      throw new Error(envName ? `The ${envName} value was rejected by Telegram. Check the token and try again.` : error.message);
    ui.warn(error instanceof Error ? error.message : String(error));
    ui.warn('Continuing without verification; the host check below is the second gate.');
  }
}

async function runTelegram(parsed: Parsed): Promise<void> {
  const action = parsed.words[0] ?? 'status';

  if (action === 'setup') {
    await runTelegramSetup(parsed);
    return;
  }
  if (action === 'disable' || action === 'unpair') {
    const settings = loadSettings();
    if (!settings.telegram) {
      ui.info('Telegram is not configured.');
      return;
    }
    if (action === 'disable') settings.telegram.enabled = false;
    else {
      delete settings.telegram.chatId;
      delete settings.telegram.userId;
    }
    saveSettings(settings);
    if (await getDaemonStatus()) await requestHost('settings.reload');
    ui.success(action === 'disable' ? 'Telegram disabled.' : 'Telegram owner pairing removed.');
    return;
  }
  if (action === 'reset') {
    const settings = loadSettings();
    const tokenEnv = settings.telegram?.tokenEnv;
    if (!settings.telegram) {
      ui.info('Telegram is not configured.');
      return;
    }
    if (process.stdin.isTTY) {
      const { confirm } = await import('@inquirer/prompts');
      const proceed = await confirm({
        message: 'Forget the owner chat, disable the channel, and remove the Telegram settings?',
        default: true,
      });
      if (!proceed) return;
    }
    delete settings.telegram;
    saveSettings(settings);
    let removeEnv = parsed.booleans.has('remove-env');
    if (!removeEnv && process.stdin.isTTY === true && tokenEnv) {
      const { confirm } = await import('@inquirer/prompts');
      removeEnv = await confirm({ message: `Also remove ${tokenEnv} from the user environment?`, default: true });
    }
    if (removeEnv && tokenEnv) {
      try {
        const { location } = await removeTokenEnv(tokenEnv);
        ui.success(`Token removed (${location}).`);
      } catch (error) {
        ui.warn(error instanceof Error ? error.message : String(error));
      }
    } else if (tokenEnv) {
      ui.info(`The ${tokenEnv} value stays in the user environment; remove it manually or re-run with --remove-env.`);
    }
    if (process.platform === 'darwin' || process.platform === 'linux') {
      try {
        refreshAutostartEnv();
      } catch (error) {
        ui.warn(`Login startup unwiring failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (await getDaemonStatus()) await requestHost('settings.reload');
    ui.success('Telegram channel removed. Reconnect any time with `ranite telegram setup`.');
    return;
  }
  if (action === 'pair') {
    if (!loadSettings().telegram?.enabled) throw new Error('Configure Telegram first: ranite telegram setup');
    await startDaemon();
    await requestHost('settings.reload');
    const result = (await requestHost('telegram.pair')) as { code: string; expiresAt: string; username: string | null };
    ui.info('Open your bot and send this one-time pairing command:');
    ui.line(`/start ${result.code}`);
    if (result.username) ui.line(`https://t.me/${result.username}?start=${result.code}`);
    ui.kv('Expires', result.expiresAt);
    return;
  }
  if (action === 'status') {
    if (!(await getDaemonStatus())) {
      ui.info(loadSettings().telegram ? 'Telegram is configured; the host is not running.' : 'Telegram is not configured.');
      return;
    }
    const status = (await requestHost('telegram.status')) as TelegramStatus;
    ui.kv('State', status.state);
    ui.kv('Paired owner', status.paired ? 'yes' : 'no');
    if (status.username) ui.kv('Bot', status.username);
    if (status.error) ui.warn(status.error);
    return;
  }
  throw new Error(
    'Usage: ranite telegram [setup|pair|status|disable|unpair|reset] [--token-env=NAME] [--workspace=PATH] [--no-wait] [--skip-test] [--remove-env]',
  );
}

async function runSessionsCommand(parsed: Parsed): Promise<void> {
  if (parsed.words[0] === 'index') {
    await runSessionsIndex(parsed);
    return;
  }
  if (parsed.words[0] !== 'prune') throw new Error('Usage: ranite sessions [index [--rebuild] | prune --older-than <duration> [--yes]]');
  const olderThan = parsed.flags.get('older-than');
  if (!olderThan) throw new Error('Usage: ranite sessions prune --older-than <duration> [--yes]');
  const cutoff = Date.now() - parseRetentionDuration(olderThan);
  const { listSessionFiles } = await import('./session-store.js');
  const files = selectFilesToPrune(listSessionFiles(), cutoff);
  if (files.length === 0) {
    ui.info(`No session files are older than ${olderThan}; nothing to prune.`);
    return;
  }
  const totalBytes = files.reduce((sum, file) => sum + file.sizeBytes, 0);
  for (const file of files) {
    ui.line(`  ${new Date(file.modifiedAt).toISOString().slice(0, 10)}  ${file.id}  ${ui.bytes(file.sizeBytes)}`);
  }
  if (!parsed.booleans.has('yes')) {
    ui.info(`${files.length} session file(s), ${ui.bytes(totalBytes)} total. Nothing was deleted; re-run with --yes to delete them.`);
    return;
  }
  let removed = 0;
  let failed = 0;
  const removedIds: string[] = [];
  for (const file of files) {
    try {
      rmSync(file.path, { force: true });
      removed += 1;
      removedIds.push(file.id);
    } catch {
      failed += 1;
    }
  }
  if (removedIds.length > 0) {
    const { SessionIndex } = await import('./session-index.js');
    const index = new SessionIndex(getDataPath('custodian'));
    try {
      index.removeSessions(removedIds);
    } finally {
      await index.close();
    }
  }
  ui.success(`Deleted ${removed} session file(s) (${ui.bytes(totalBytes)}).`);
  if (failed > 0) ui.warn(`${failed} file(s) could not be deleted.`);
}

async function runSessionsIndex(parsed: Parsed): Promise<void> {
  const { SessionIndex } = await import('./session-index.js');
  const index = new SessionIndex(getDataPath('custodian'));
  try {
    if (parsed.booleans.has('rebuild')) {
      index.rebuild();
      ui.info('Dropped the derived session index; rebuilding from the session files.');
    }
    await index.ensureIndexed();
    for (let round = 0; round < 100; round++) {
      if ((await index.embedPending()) === 0) break;
    }
    const counts = index.collectCounts();
    ui.kv('Sessions', String(counts.sessions));
    ui.kv('Entries', String(counts.entries));
    ui.kv('Embeddings', String(counts.embeddings));
    if (counts.pendingEmbeddings > 0) {
      ui.warn(
        `${counts.pendingEmbeddings} entry/entries still await embeddings. Prepare the local model with \`ranite setup\`, then run this again.`,
      );
    } else {
      ui.success('Session search index is up to date.');
    }
  } finally {
    await index.close();
  }
}

async function runLedgerPrune(kind: 'events' | 'actions', parsed: Parsed): Promise<void> {
  const olderThan = parsed.flags.get('older-than');
  if (!olderThan) throw new Error(`Usage: ranite ${kind} prune --older-than <duration> [--yes]`);
  if (await getDaemonStatus()) {
    throw new Error('Stop the background host first (`ranite daemon stop`) so the ledger is not in use while pruning.');
  }
  const path = getDataPath('state.db');
  if (!existsSync(path)) {
    ui.info('No activity has been recorded.');
    return;
  }
  const cutoffIso = new Date(Date.now() - parseRetentionDuration(olderThan)).toISOString();
  const { ActivityLedger } = await import('./activity-ledger.js');
  const ledger = new ActivityLedger(path);
  try {
    const counts = parsed.booleans.has('yes') ? ledger.pruneBefore(cutoffIso, kind) : ledger.previewPruneBefore(cutoffIso, kind);
    const total = counts.events + counts.actions + counts.transitions;
    if (total === 0) {
      ui.info(`No ${kind} records are older than ${olderThan}; nothing to prune.`);
      return;
    }
    ui.line(`  ${counts.events} event(s), ${counts.actions} action(s), ${counts.transitions} transition(s)`);
    if (parsed.booleans.has('yes')) ui.success(`Pruned ${total} record(s).`);
    else ui.info(`Nothing was deleted; re-run with --yes to delete these ${total} record(s).`);
  } finally {
    ledger.close();
  }
}

async function runActivityLedger(parsed: Parsed, kind: 'events' | 'actions'): Promise<void> {
  if (parsed.words[0] === 'prune') {
    await runLedgerPrune(kind, parsed);
    return;
  }
  if (kind === 'events' && parsed.words[0] === 'retry') {
    const eventId = parsed.words[1];
    if (!eventId) throw new Error('Provide an event id to retry.');
    await startDaemon();
    ui.line(JSON.stringify(await requestHost('events.retry', { eventId }), null, 2));
    return;
  }
  const path = getDataPath('state.db');
  if (!existsSync(path)) {
    ui.info('No activity has been recorded.');
    return;
  }
  const { ActivityLedger } = await import('./activity-ledger.js');
  const ledger = new ActivityLedger(path, { readOnly: true });
  try {
    const rows = kind === 'events' ? ledger.listEvents() : ledger.listActions();
    ui.line(JSON.stringify(rows, null, 2));
  } finally {
    ledger.close();
  }
}

async function runDaemonCommand(action: string): Promise<void> {
  if (action === 'run') {
    await runDaemonProcess();
    return;
  }
  if (action === 'install') {
    if (isAutostartInstalled()) {
      ui.info(`Automatic startup is already installed: ${autostartDescription()}.`);
      return;
    }
    ui.success(installAutostart());
    ui.info('Ranite will start at your next user login. Remove it with `ranite daemon uninstall`.');
    return;
  }
  if (action === 'uninstall') {
    ui.info(uninstallAutostart());
    return;
  }
  if (action === 'autostart-status') {
    ui.info(isAutostartInstalled() ? `Automatic startup is installed: ${autostartDescription()}.` : 'Automatic startup is not installed.');
    return;
  }
  if (action === 'start') {
    if (!(await defaultModelReady())) throw new Error('Configure a tool-capable default model first: ranite setup');
    let status = await startDaemon();
    ui.info('The machine custodian and its workspace runtime initialize when a TUI or Telegram turn arrives.');
    status = (await getDaemonStatus()) ?? status;
    ui.success(`Background host running (pid ${status.pid}).`);
    ui.kv('Workspaces', String(status.workspaceCount));
    ui.info('It stays alive after this terminal closes. Stop it with `ranite daemon stop`.');
    return;
  }
  if (action === 'status') {
    const status = await getDaemonStatus();
    if (!status) {
      ui.info('Background host is not running. Start it with `ranite daemon start`.');
      return;
    }
    if (status.unresponsive) {
      ui.warn(`Background host process ${status.pid} is alive but does not answer IPC health checks. Recover it with \`ranite restart\`.`);
      ui.kv('Started', status.startedAt);
      return;
    }
    ui.success(`Background host running (pid ${status.pid}).`);
    ui.kv('Started', status.startedAt);
    ui.kv('Workspaces', String(status.workspaceCount));
    ui.kv('Connected clients', String(status.connectedClients));
    ui.kv('Background tasks', String(status.backgroundTasks ?? 0));
    if (status.telegram) ui.kv('Telegram', `${status.telegram.state}${status.telegram.paired ? ' / paired' : ''}`);
    if (status.legacy) ui.warn('This host uses an older protocol. Stop it before attaching with this Ranite version.');
    ui.kv('Automatic startup', isAutostartInstalled() ? 'installed' : 'not installed');
    return;
  }
  if (action === 'stop') {
    if (await stopDaemon()) ui.success('Background host stopped.');
    else ui.info('Background host is not running.');
    return;
  }
  throw new Error('Usage: ranite daemon [start|status|stop|install|uninstall|autostart-status]');
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  // A leading session option has no command before it, so shift it into the
  // parser's regular flag list while keeping bare `ranite` unchanged.
  const parsed = args[0] === '--workspace' || args[0]?.startsWith('--workspace=') ? parseArgs(['', ...args]) : parseArgs(args);
  if (parsed.booleans.has('workspace')) throw new Error('--workspace requires a directory path.');

  if (parsed.command === '--help' || parsed.command === '-h' || parsed.command === 'help') {
    usage();
    return;
  }
  if (parsed.command === '--version' || parsed.command === '-v' || parsed.command === 'version') {
    process.stdout.write(`${getRaniteVersion()}\n`);
    return;
  }
  /* A bare `ranite` has no terminal to prompt in, so showing usage is more
     useful than failing with a TTY complaint. */
  if (parsed.bare && !process.stdin.isTTY) {
    usage();
    return;
  }

  if (parsed.flags.has('list-models') || parsed.command === '--list-models') {
    await runListModels(parsed);
    return;
  }

  if (parsed.flags.has('c') || parsed.command === '--c') {
    const question = questionFrom(parsed);
    if (!question) throw new Error('Write a request after --c.');
    ui.line(`  ${ui.color.dim('Request:')} ${question}`);
    ui.line();
    await runQuestion(question, await resolveSessionWorkspace(parsed.flags.get('workspace')));
    return;
  }

  switch (parsed.command) {
    case '': {
      if (!process.stdin.isTTY) {
        usage();
        return;
      }
      await runSession(await resolveSessionWorkspace(parsed.flags.get('workspace')));
      return;
    }
    case 'setup': {
      if (!process.stdin.isTTY) {
        throw new Error('setup needs an interactive terminal. Run it from a real terminal, or edit settings.yaml directly.');
      }

      const { runSetup } = await import('./cli/setup.js');
      await runSetup();
      return;
    }
    case 'config': {
      await runConfig();
      return;
    }
    case 'workspace': {
      runWorkspaceCommand(parsed);
      return;
    }
    case 'permissions': {
      await runPermissions(parsed);
      return;
    }
    case 'mcp': {
      await runMcpManager(parsed.words[0] ?? '');
      return;
    }
    case 'daemon': {
      await runDaemonCommand(parsed.words[0] ?? 'status');
      return;
    }
    case 'restart': {
      if (parsed.words.length > 0) throw new Error('Usage: ranite restart');

      ui.info('Stopping active runs and saving sessions…');
      const status = await restartDaemon();
      ui.success(`Background host restarted (pid ${status.pid}).`);
      ui.info('Open sessions reconnect automatically.');
      return;
    }
    case 'tasks': {
      await runTasks(parsed);
      return;
    }
    case 'telegram': {
      await runTelegram(parsed);
      return;
    }
    case 'events': {
      await runActivityLedger(parsed, 'events');
      return;
    }
    case 'actions': {
      await runActivityLedger(parsed, 'actions');
      return;
    }
    case 'sessions': {
      await runSessionsCommand(parsed);
      return;
    }
    case 'about': {
      runAbout();
      return;
    }
    case 'skills': {
      await runSkills(parsed);
      return;
    }
    case 'uninstall': {
      await runUninstall(parsed);
      return;
    }
    default: {
      ui.failure(`Unknown command "${parsed.command}".`);
      usage();
      process.exitCode = 1;
    }
  }
}

main().catch((error: unknown) => {
  if (error instanceof Error && (error.name === 'ExitPromptError' || error.name === 'AbortPromptError')) {
    ui.line();
    ui.info('Cancelled. Nothing was written.');
    process.exitCode = 1;
    return;
  }
  ui.failure(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
