import { spawn, spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { ToolDefinition } from './registry.js';
import { classifyTrustedPath, trustedRootsFor } from '../workspace-scope.js';
import { DEFAULT_TOOL_TIMEOUT_SECONDS, runWithToolTimeout, ToolTimeoutError } from './timeout.js';

const MAX_COMMAND_CHARS = 10_000;
const MAX_OUTPUT_CHARS = 24_000;

export function createExecuteCommandTool(startDirectory: string): ToolDefinition {
  const workspaceRoot = canonicalPath(startDirectory);
  return {
    providerId: 'host',
    name: 'execute_command',
    description: `Run a shell command in the active workspace (${workspaceRoot}) by default. Use cwd for another directory. Shell commands can create, replace, and append to files independently of file_write, including files already read or written in this session. After a command that edits a file, file_read.sha256 reports its current on-disk hash. Out-of-workspace working directories and common explicit paths use the configured permission mode.`,
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The exact shell command to run.' },
        cwd: { type: 'string', description: 'Optional working directory. Relative paths are resolved from the session workspace.' },
      },
      required: ['command'],
      additionalProperties: false,
    },
    effect: { change: 'unknown', data: 'unknown', network: 'possible', reversible: 'unknown', outbound: 'model' },
    resolveTarget: (input) => resolveCommandDirectory(input.cwd, workspaceRoot),
    workspaceScope: (input, target) => {
      const command = typeof input.command === 'string' ? input.command : '';
      const trustedRoots = trustedRootsFor(workspaceRoot);
      const cwd = target ?? resolveCommandDirectory(input.cwd, workspaceRoot);
      const cwdScope = classifyTrustedPath(cwd, trustedRoots);
      if (cwdScope !== 'workspace') return cwdScope;
      if (commandChangesDirectoryOutsideWorkspace(command, cwd, trustedRoots)) return 'outside';
      if (commandMayAccessOutsideWorkspace(command, cwd, trustedRoots)) return 'outside';
      return 'workspace';
    },
    execute: async (input, signal, context) => {
      const rawCommand = input.command;
      if (typeof rawCommand !== 'string') return { status: 'invalid', error: 'command must be a string.' };
      const command = rawCommand.trim().replace(/\r\n/g, '\n');
      if (!command || command.length > MAX_COMMAND_CHARS || /[\u0000-\u0008\u000B-\u001F\u007F]/.test(command)) {
        return { status: 'invalid', error: `command must be 1-${MAX_COMMAND_CHARS} characters and contain no control characters.` };
      }
      const run = (operationSignal: AbortSignal | undefined) =>
        runShell(command, context?.target ?? resolveCommandDirectory(input.cwd, workspaceRoot), operationSignal);
      if (signal?.aborted) return run(signal);
      return runWithToolTimeout(context?.timeoutSeconds ?? DEFAULT_TOOL_TIMEOUT_SECONDS, signal, run);
    },
  };
}

function resolveCommandDirectory(value: unknown, workspaceRoot: string): string {
  const requested = typeof value === 'string' && value.trim() ? value.trim() : workspaceRoot;
  return canonicalPath(isAbsolute(requested) ? requested : resolve(workspaceRoot, requested));
}

function canonicalPath(path: string): string {
  const absolute = resolve(path);
  try {
    return realpathSync(absolute);
  } catch {
    return absolute;
  }
}

function isWithinDirectory(root: string, target: string): boolean {
  const relativePath = relative(root, target);
  return relativePath === '' || (relativePath !== '..' && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath));
}

function commandChangesDirectoryOutsideWorkspace(command: string, cwd: string, trustedRoots: readonly string[]): boolean {
  let currentDirectory = cwd;
  const segments = command.split(/&&|\|\||[;&|\n]/);
  for (const segment of segments) {
    const match = /\b(cd|chdir|pushd|push-location|popd|pop-location|set-location|sl)\b(.*)$/i.exec(segment);
    if (!match) continue;
    const operation = match[1]!.toLowerCase();
    if (operation === 'popd' || operation === 'pop-location') return true;
    let target = match[2]!.trim();
    target = target.replace(/^(?:--|-path|-literalpath)\s+/i, '');
    if (!target || /[$%~]/.test(target)) return true;
    const quoted = /^(?:"([^"]+)"|'([^']+)')$/.exec(target);
    if (quoted) target = quoted[1] ?? quoted[2]!;
    else if (/\s/.test(target)) return true;
    currentDirectory = canonicalPath(isAbsolute(target) ? target : resolve(currentDirectory, target));
    if (!trustedRoots.some((root) => isWithinDirectory(root, currentDirectory))) return true;
  }
  return false;
}

function commandMayAccessOutsideWorkspace(command: string, cwd: string, trustedRoots: readonly string[]): boolean {
  if (/\b(?:npm|pnpm|bun)\s+(?:install|i|add)\b[^&;|]*(?:\s-g\b|\s--global\b|\s--location=global\b|\s--prefix(?:=|\s))/i.test(command))
    return true;
  if (/\b(?:npm|pnpm|bun)\s+link\b|\byarn\s+global\s+(?:add|remove|upgrade)\b/i.test(command)) return true;
  if (/\b(?:pip\d*|python(?:\d+(?:\.\d+)?)?)\s+(?:-m\s+pip\s+)?(?:install|uninstall)\b/i.test(command)) return true;
  if (
    /\b(?:brew|apt|apt-get|dnf|yum|pacman|zypper|choco|scoop|winget)\s+(?:install|remove|uninstall|upgrade|update|link|tap)\b/i.test(
      command,
    )
  )
    return true;
  if (/(?:^|[;&|\s])(?:sudo|doas)\s|\b(?:Invoke-Expression|iex)\b/i.test(command)) return true;
  if (
    /\$\(|`[^`]*`|\$\{[^}]+\}|\$(?:HOME|USERPROFILE|APPDATA|LOCALAPPDATA)\b|\$env:(?:USERPROFILE|APPDATA|LOCALAPPDATA|HOMEDRIVE|HOMEPATH)\b|%(?:USERPROFILE|APPDATA|LOCALAPPDATA)%/i.test(
      command,
    )
  )
    return true;

  // Remote fetchers run content this machine has not reviewed; their effect is
  // never bounded by the workspace, whether they write a file or feed a pipe.
  if (/\b(?:curl|wget|iwr|Invoke-WebRequest|irm|Invoke-RestMethod|Start-BitsTransfer|bitsadmin)\b/i.test(command)) return true;
  // Anything piped into a shell or interpreter is code from an unreviewed producer.
  if (
    /\|\s*(?:[^\s|;&]*[\\/])?(?:sh|bash|zsh|dash|ksh|csh|tcsh|fish|python\d*|node|perl|ruby|php|lua|osascript|iex|Invoke-Expression|cmd|powershell|pwsh)\b/i.test(
      command,
    )
  )
    return true;

  const text = command.replace(/\bhttps?:\/\/[^\s"'`<>|;&,)\]}]*/gi, ' ');
  const pathPatterns = [
    /(?:^|[\s"'=:(])([A-Za-z]:[\\/][^\s"'`<>|;&,)\]}]*)/g,
    /(?:^|[\s"'=:(])(\\\\[^\\/\s]+[\\/][^\s"'`<>|;&,)\]}]*)/g,
    /(?:^|[\s"'=:(])((?:\.\.|\.\.?)[\\/][^\s"'`<>|;&,)\]}]*)/g,
    /(?:^|[\s"'=:(])(~[\\/][^\s"'`<>|;&,)\]}]*)/g,
    /(?:^|[\s"'=:(])(\/(?!\/)[^\s"'`<>|;&,)\]}]*)/g,
  ];
  for (const pattern of pathPatterns) {
    for (const match of text.matchAll(pattern)) {
      const candidate = match[1];
      if (!candidate) continue;
      const expanded = candidate.startsWith('~')
        ? resolve(homedir(), candidate.slice(2))
        : isAbsolute(candidate)
          ? candidate
          : resolve(cwd, candidate);
      if (classifyTrustedPath(expanded, trustedRoots) !== 'workspace') return true;
    }
  }
  return false;
}

function cleanOutput(value: string): string {
  return value
    .replace(/\u001B\][^\u0007]*(?:\u0007|\u001B\\)/g, '')
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\u001B[@-_]/g, '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
}

function runShell(command: string, cwd: string, signal?: AbortSignal): Promise<unknown> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve({ status: 'cancelled', exitCode: null, stdout: '', stderr: '', error: 'Command was stopped by the user.', truncated: false });
      return;
    }
    const windows = process.platform === 'win32';
    const executable = windows ? 'powershell.exe' : '/bin/sh';
    const args = windows ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command] : ['-c', command];
    let stdout = '';
    let stderr = '';
    let truncated = false;
    let settled = false;

    const child = spawn(executable, args, {
      cwd,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      // POSIX only: give the shell its own process group so a stop can signal the
      // whole group. On Windows this flag means "new console window", so it must
      // never be set there.
      ...(windows ? {} : { detached: true }),
    });
    const append = (current: string, chunk: Buffer): string => {
      const next = current + chunk.toString('utf8');
      if (next.length > MAX_OUTPUT_CHARS) {
        truncated = true;
        return next.slice(0, MAX_OUTPUT_CHARS);
      }
      return next;
    };
    const finish = (result: unknown) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      resolve(result);
    };
    const stop = (status: 'cancelled' | 'timed_out', error: string) => {
      if (settled) return;
      finish({ status, exitCode: child.exitCode, stdout: cleanOutput(stdout), stderr: cleanOutput(stderr), error, truncated });
      // An exited shell can leave inherited pipes open. Cancellation must not wait for its `close` event.
      //
      // The shell alone is not enough. A command routinely starts programs of its own, and killing
      // only the shell would leave those running while the ledger records the action as stopped —
      // so "durdu" would be a claim nothing enforces. Take the whole tree down, then kill the shell
      // directly in case the tree walk did not reach it.
      killProcessTree(child.pid);
      child.kill();
      child.stdout.destroy();
      child.stderr.destroy();
    };
    const onAbort = () =>
      signal?.reason instanceof ToolTimeoutError
        ? stop('timed_out', signal.reason.message)
        : stop('cancelled', 'Command was stopped by the user.');

    child.stdout.on('data', (chunk: Buffer) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = append(stderr, chunk);
    });
    child.on('error', (error) =>
      finish({
        status: 'failed',
        exitCode: null,
        stdout: cleanOutput(stdout),
        stderr: cleanOutput(stderr),
        error: error.message,
        truncated,
      }),
    );
    child.on('close', (code) =>
      finish({
        status: code === 0 ? 'completed' : 'failed',
        exitCode: code,
        stdout: cleanOutput(stdout),
        stderr: cleanOutput(stderr),
        error: null,
        truncated,
      }),
    );
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

/**
 * Terminates everything the shell started, not just the shell.
 *
 * Best effort by design: it runs on the stop path, where reporting a timeout or a
 * cancellation must not be delayed by a process that refuses to die, and where a
 * shell that already exited on its own is the normal case. A pid we cannot
 * identify is never passed to a killer.
 *
 * This cannot reach a process that deliberately leaves the tree it was started in
 * — a scheduled task, a service, or anything re-parented elsewhere. Windows Job
 * Objects would close that gap and need a native addon; `/T` covers the ordinary case.
 */
function killProcessTree(pid: number | undefined): void {
  if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0) return;
  if (process.platform === 'win32') {
    try {
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', timeout: 1_000, windowsHide: true });
    } catch {
      /* the shell may already be gone; the direct kill still runs */
    }
    return;
  }
  // The shell was spawned detached, so its pid is its process group id.
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    /* already gone, or the group is empty */
  }
}
