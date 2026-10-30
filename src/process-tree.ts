import { execFile } from 'node:child_process';
import { basename } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface KillPlan {
  command: string;
  args: string[];
}

/**
 * The command that removes a process together with everything it spawned.
 *
 * Windows has a real tree kill (`taskkill /T`); that matters because a stdio MCP server
 * is usually a wrapper (`cmd /c npx ...`) whose grandchildren survive a plain kill of the
 * wrapper — the leak this module exists for. On POSIX there is no portable tree kill for
 * a child we did not put into its own process group, so the plan signals the pid we own
 * and the SDK's own close covers the rest.
 */
export function treeKillCommand(pid: number): KillPlan | null {
  if (!Number.isSafeInteger(pid) || pid <= 1) return null;
  if (process.platform === 'win32') return { command: 'taskkill', args: ['/PID', String(pid), '/T', '/F'] };
  return { command: 'kill', args: ['-KILL', String(pid)] };
}

/**
 * A live command line belongs to this server only when it still names the command OpenButler
 * spawned and that spawn's first argument: a recycled pid must never be killed, so an
 * unreadable or foreign command line refuses the kill instead of guessing.
 */
export function commandLineMatchesSpawn(commandLine: string | null, spawnCommand: string, spawnArgs: readonly string[] = []): boolean {
  if (!commandLine) return false;
  const lower = commandLine.toLowerCase();
  const command = basename(spawnCommand.replace(/^"(.*)"$/, '$1')).toLowerCase();
  if (!command || !lower.includes(command)) return false;
  const first = spawnArgs[0];
  if (!first) return true;
  return lower.includes(first.toLowerCase());
}

/** The live command line of a pid, or null when it cannot be read. */
export async function readProcessCommandLine(pid: number): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      process.platform === 'win32' ? 'powershell.exe' : 'ps',
      process.platform === 'win32'
        ? [
            '-NoLogo',
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            `$p = Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}'; if ($null -eq $p) { exit 1 }; $p.CommandLine`,
          ]
        : ['-p', String(pid), '-o', 'args='],
      { windowsHide: true, timeout: 3_000, maxBuffer: 16_384, env: { ...process.env, LC_ALL: 'C' } },
    );
    const line = stdout.trim();
    return line ? line : null;
  } catch {
    return null;
  }
}

export type TreeKillOutcome =
  /** The tree still matched this spawn and was killed. */
  | 'killed'
  /** The pid names something else (recycled) — nothing was touched. */
  | 'unowned'
  /** The pid is gone or its command line could not be verified. */
  | 'unavailable';

/**
 * Kills `pid` with its whole tree, but only while the live process still names the
 * command and first argument this spawn used. Verification is the price of a tree kill:
 * `taskkill /T /F` on a recycled pid would kill a stranger's process.
 */
export async function killProcessTree(
  pid: number | null | undefined,
  spawnCommand: string,
  spawnArgs: readonly string[] = [],
): Promise<TreeKillOutcome> {
  if (pid === null || pid === undefined) return 'unavailable';
  const plan = treeKillCommand(pid);
  if (!plan) return 'unavailable';
  let commandLine: string | null;
  try {
    commandLine = await readProcessCommandLine(pid);
  } catch {
    commandLine = null;
  }
  if (!commandLineMatchesSpawn(commandLine, spawnCommand, spawnArgs)) return commandLine === null ? 'unavailable' : 'unowned';
  try {
    await execFileAsync(plan.command, plan.args, {
      windowsHide: true,
      timeout: 5_000,
      maxBuffer: 64 * 1024,
      env: { ...process.env },
    });
  } catch {
    return 'unavailable';
  }
  return 'killed';
}
