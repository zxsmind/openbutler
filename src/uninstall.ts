import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { Parsed } from './cli/args.js';
import * as ui from './cli/ui.js';
import { getDaemonStatus, stopDaemon } from './daemon.js';
import { isAutostartInstalled, uninstallAutostart } from './daemon-autostart.js';
import { getDataDir } from './paths.js';

const INSTALLER_MARKER = '# Added by the openbutler installer.';

export interface UninstallOptions {
  purge: boolean;
  dryRun: boolean;
  force: boolean;
}

export interface UninstallTargets {
  installDir: string | null;
  binDir: string | null;
  dataDir: string;
  autostartInstalled: boolean;
  shellConfig: { file: string; content: string } | null;
  windowsPath: { value: string; type: string } | null;
}

/**
 * Walks up from the running CLI entry point to the directory the installer
 * created, which holds `app/`, `bin/`, and `node/`. Returns null when OpenButler
 * runs from a source checkout instead of an installer layout.
 */
export function findInstallDir(entry: string): string | null {
  let directory = dirname(resolve(entry));
  for (;;) {
    if (existsSync(join(directory, 'app', 'dist', 'cli.js')) && existsSync(join(directory, 'node')) && existsSync(join(directory, 'bin'))) {
      return directory;
    }
    const parent = dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}

/** Removes the installer's marker line and its `export PATH` line for `binDir`. */
export function stripInstallerPathBlock(content: string, binDir: string): string {
  const lines = content.split('\n');
  const kept: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = lines[index].trim();
    if (trimmed === INSTALLER_MARKER) {
      const next = lines[index + 1];
      if (next !== undefined && next.includes(binDir)) index += 1;
      continue;
    }
    if (trimmed.startsWith('export PATH=') && trimmed.includes(binDir)) continue;
    if (trimmed.startsWith('fish_add_path') && trimmed.includes(binDir)) continue;
    kept.push(lines[index]);
  }
  while (kept.length > 0 && kept[kept.length - 1].trim() === '') kept.pop();
  return kept.length > 0 ? `${kept.join('\n')}\n` : '';
}

/** Drops the installer's bin directory from a `;`-separated Windows PATH value. */
export function removeFromWindowsPath(value: string, binDir: string): string {
  const wanted = normalizeWindowsPathEntry(binDir);
  return value
    .split(';')
    .filter((entry) => entry !== '' && normalizeWindowsPathEntry(entry) !== wanted)
    .join(';');
}

function normalizeWindowsPathEntry(entry: string): string {
  return entry
    .trim()
    .replace(/[\\/]+$/, '')
    .toLowerCase();
}

function shellConfigCandidates(): string[] {
  const home = homedir();
  const xdg = process.env.XDG_CONFIG_HOME ?? join(home, '.config');
  const zdotdir = process.env.ZDOTDIR ?? home;
  const shell = (process.env.SHELL ? process.env.SHELL.split(/[\\/]/).pop() : '') ?? '';
  switch (shell) {
    case 'fish':
      return [join(xdg, 'fish', 'config.fish')];
    case 'zsh':
      return [join(zdotdir, '.zshrc'), join(zdotdir, '.zshenv'), join(xdg, 'zsh', '.zshrc'), join(xdg, 'zsh', '.zshenv')];
    case 'bash':
      return [
        join(home, '.bashrc'),
        join(home, '.bash_profile'),
        join(home, '.profile'),
        join(xdg, 'bash', '.bashrc'),
        join(xdg, 'bash', '.bash_profile'),
      ];
    case 'ash':
    case 'dash':
      return [join(home, '.ashrc'), join(home, '.profile')];
    default:
      return [join(home, '.profile')];
  }
}

function findShellConfig(binDir: string): { file: string; content: string } | null {
  for (const file of shellConfigCandidates()) {
    try {
      const content = readFileSync(file, 'utf8');
      if (content.includes(binDir)) return { file, content };
    } catch {
      /* candidate does not exist or is unreadable */
    }
  }
  return null;
}

function readWindowsUserPath(): { value: string; type: string } | null {
  const result = spawnSync('reg.exe', ['query', 'HKCU\\Environment', '/v', 'Path'], { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) return null;
  const match = /^\s*Path\s+(REG_[A-Z_]+)\s+(.*)$/im.exec(result.stdout ?? '');
  if (!match) return null;
  return { type: match[1], value: match[2].trim() };
}

function writeWindowsUserPath(value: string, type: string): void {
  const result = spawnSync('reg.exe', ['add', 'HKCU\\Environment', '/v', 'Path', '/t', type, '/d', value, '/f'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.status !== 0) throw new Error(`Could not update the user PATH: ${(result.stderr ?? '').trim()}`);
}

export function collectUninstallTargets(entry: string): UninstallTargets {
  const installDir = findInstallDir(entry);
  const binDir = installDir === null ? null : join(installDir, 'bin');
  return {
    installDir,
    binDir,
    dataDir: getDataDir(),
    autostartInstalled: isAutostartInstalled(),
    shellConfig: binDir !== null && process.platform !== 'win32' ? findShellConfig(binDir) : null,
    windowsPath: binDir !== null && process.platform === 'win32' ? readWindowsUserPath() : null,
  };
}

function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Removes the install tree; schedules the rest when the running process locks it. */
function removeInstallDir(installDir: string, entry: string): 'removed' | 'scheduled' {
  const inside = resolve(entry).startsWith(resolve(installDir));
  try {
    rmSync(installDir, { recursive: true, force: true });
    return 'removed';
  } catch {
    if (!inside) throw new Error(`Could not remove ${installDir}.`);
    scheduleDeferredRemoval(installDir);
    return 'scheduled';
  }
}

function scheduleDeferredRemoval(directory: string): void {
  if (process.platform === 'win32') {
    const script = `$p=${process.pid}; while (Get-Process -Id $p -ErrorAction SilentlyContinue) { Start-Sleep -Milliseconds 300 }; Remove-Item -LiteralPath '${directory.replace(/'/g, "''")}' -Recurse -Force -ErrorAction SilentlyContinue`;
    spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    }).unref();
    return;
  }
  const script = `while kill -0 ${process.pid} 2>/dev/null; do sleep 0.2; done; rm -rf ${shQuote(directory)}`;
  spawn('sh', ['-c', script], { detached: true, stdio: 'ignore' }).unref();
}

export async function runUninstall(parsed: Parsed): Promise<void> {
  if (parsed.words.length > 0) throw new Error('Usage: openbutler uninstall [--purge] [--dry-run] [--force]');
  const options: UninstallOptions = {
    purge: parsed.booleans.has('purge'),
    dryRun: parsed.booleans.has('dry-run'),
    force: parsed.booleans.has('force'),
  };

  const entry = process.argv[1];
  const targets = collectUninstallTargets(entry ?? '');
  const hostRunning = (await getDaemonStatus()) !== null;

  ui.section('Uninstall OpenButler');
  if (targets.installDir === null) {
    ui.warn('This OpenButler was not installed by the installer, so there is no program directory to remove.');
  } else {
    ui.kv('Program', targets.installDir);
    if (targets.binDir !== null) ui.kv('PATH entry', targets.binDir);
  }
  ui.kv('Data', `${targets.dataDir} ${options.purge ? '(will be removed)' : '(kept)'}`);
  if (hostRunning) ui.kv('Background host', 'running (will be stopped)');
  if (targets.autostartInstalled) ui.kv('Login startup', 'installed (will be removed)');

  if (targets.installDir === null && !targets.autostartInstalled && !hostRunning && !options.purge) {
    ui.info('Nothing to remove.');
    return;
  }

  if (options.dryRun) {
    ui.info('Dry run: nothing was changed.');
    return;
  }

  if (!options.force) {
    if (!process.stdin.isTTY) throw new Error('Refusing to uninstall without a terminal. Re-run with --force to skip the prompt.');
    const { confirm } = await import('@inquirer/prompts');
    const proceed = await confirm({
      message: options.purge ? 'Remove the program and all data (memories, sessions, settings)?' : 'Remove the program? Your data is kept.',
      default: false,
    });
    if (!proceed) {
      ui.info('Cancelled. Nothing was removed.');
      return;
    }
  }

  if (hostRunning && (await stopDaemon())) ui.success('Background host stopped.');
  if (targets.autostartInstalled) ui.info(uninstallAutostart());

  if (targets.shellConfig !== null && targets.binDir !== null) {
    writeFileSync(targets.shellConfig.file, stripInstallerPathBlock(targets.shellConfig.content, targets.binDir), 'utf8');
    ui.success(`Removed the PATH entry from ${targets.shellConfig.file}.`);
  }
  if (targets.windowsPath !== null && targets.binDir !== null) {
    const cleaned = removeFromWindowsPath(targets.windowsPath.value, targets.binDir);
    if (cleaned !== targets.windowsPath.value) {
      writeWindowsUserPath(cleaned, targets.windowsPath.type);
      ui.success('Removed the PATH entry from the user environment.');
    }
  }

  if (targets.installDir !== null) {
    const outcome = removeInstallDir(targets.installDir, entry ?? '');
    if (outcome === 'removed') ui.success('Program files removed.');
    else ui.info('Program files will be removed as this process exits.');
  }

  if (options.purge) {
    try {
      rmSync(targets.dataDir, { recursive: true, force: true });
      ui.success('Data removed.');
    } catch {
      ui.warn(`Could not fully remove ${targets.dataDir}; delete it manually.`);
    }
  } else if (targets.installDir !== null) {
    ui.info(`Your data stays at ${targets.dataDir}. Delete that folder to remove it.`);
  }

  ui.line();
  ui.success('OpenButler uninstalled. Restart your terminal to clear the PATH entry from this session.');
}
