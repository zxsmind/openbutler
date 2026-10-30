import { existsSync, mkdirSync, renameSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Where openbutler keeps state.
 *
 * Everything openbutler writes goes through here. Nothing is written inside the
 * checkout: a CLI that scatters caches next to its own source is a CLI that
 * breaks on a read-only install and shows up in the user's git status.
 *
 * Before the rename the product kept its state in a sibling directory named
 * `ranite`. A first run of the new name adopts that directory instead of
 * starting empty, which would look like every session, key and setting had been
 * deleted. The move is skipped when the new directory already exists: two
 * populated directories are resolved in favor of the current one rather than
 * merged blindly.
 */
export function getDataDir(): string {
  if (process.env.OPENBUTLER_DATA_DIR) return process.env.OPENBUTLER_DATA_DIR;
  return migrateLegacyDataDir(defaultDataDir('openbutler'), defaultDataDir('ranite'));
}

function defaultDataDir(name: string): string {
  if (process.platform === 'win32') {
    const base = process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local');
    return join(base, name);
  }
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', name);
  const base = process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share');
  return join(base, name);
}

let resolvedDataDir: string | null = null;

function migrateLegacyDataDir(current: string, legacy: string): string {
  if (resolvedDataDir !== null) return resolvedDataDir;
  if (existsSync(current) || !existsSync(legacy)) {
    resolvedDataDir = current;
    return current;
  }
  try {
    renameSync(legacy, current);
    resolvedDataDir = current;
  } catch {
    // A locked or read-only directory must not make the CLI unusable; keep
    // reading the old location until the move can succeed on a later run.
    resolvedDataDir = legacy;
  }
  return resolvedDataDir;
}

/** A path inside the data directory, or the data directory itself. */
export function getDataPath(name?: string): string {
  return name === undefined ? getDataDir() : join(getDataDir(), name);
}

/**
 * Short-lived scratch space for the agent's own work: throwaway scripts, test
 * output, notes it makes for itself. Kept outside the data directory because
 * the data directory is durable user state, and dated so a day of scratch can
 * be discarded without touching anything worth keeping. The host's temp
 * directory may be cleaned by the OS at any time, which is the point.
 */
export function getScratchRoot(): string {
  const date = new Date();
  const day = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  return join(tmpdir(), 'openbutler', day);
}

/**
 * Working directory for spawned MCP servers.
 *
 * An MCP server is third-party code that is free to write relative to wherever it
 * is started. Inheriting this process's directory would put its scratch files in
 * the checkout during development and in the user's own project directory in
 * every other case, which is the exact failure the rule above exists to prevent.
 * Servers that need a specific directory declare `cwd` in their settings.
 */
export function getMcpWorkingDirectory(): string {
  const directory = getDataPath('mcp');
  mkdirSync(directory, { recursive: true });
  return directory;
}
