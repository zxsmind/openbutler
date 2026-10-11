import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Where ranite keeps state.
 *
 * Everything ranite writes goes through here. Nothing is written inside the
 * checkout: a CLI that scatters caches next to its own source is a CLI that
 * breaks on a read-only install and shows up in the user's git status.
 */
export function getDataDir(): string {
  if (process.env.RANITE_DATA_DIR) return process.env.RANITE_DATA_DIR;
  if (process.platform === 'win32') {
    const base = process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local');
    return join(base, 'ranite');
  }
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'ranite');
  const base = process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share');
  return join(base, 'ranite');
}

/** A path inside the data directory, or the data directory itself. */
export function getDataPath(name?: string): string {
  return name === undefined ? getDataDir() : join(getDataDir(), name);
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
