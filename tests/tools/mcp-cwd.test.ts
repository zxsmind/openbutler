import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'ranite-mcp-cwd-'));
  process.env.RANITE_DATA_DIR = dataDir;
});

afterEach(() => {
  delete process.env.RANITE_DATA_DIR;
});

/**
 * A stdio MCP server is third-party code that writes relative to its working
 * directory. Inheriting Ranite's own directory leaked its scratch files into the
 * checkout in development and into the user's project directory otherwise, so the
 * directory is pinned to the data directory instead.
 */
async function loadMcpModule(): Promise<typeof import('../../src/tools/mcp.js')> {
  vi.resetModules();
  return import('../../src/tools/mcp.js');
}

describe('stdio MCP working directory', () => {
  it('starts the server inside the data directory, not the process directory', async () => {
    const { resolveStdioWorkingDirectory } = await loadMcpModule();
    const resolved = resolveStdioWorkingDirectory(undefined);

    expect(resolved).toBe(join(dataDir, 'mcp'));
    expect(resolved).not.toBe(process.cwd());
  });

  it('creates the directory so a server can write into it immediately', async () => {
    const { resolveStdioWorkingDirectory } = await loadMcpModule();
    const { existsSync } = await import('node:fs');

    const resolved = resolveStdioWorkingDirectory(undefined);
    expect(existsSync(resolved)).toBe(true);
  });

  it('honours a cwd the user declared in settings', async () => {
    const { resolveStdioWorkingDirectory } = await loadMcpModule();
    const declared = join(dataDir, 'somewhere-else');

    expect(resolveStdioWorkingDirectory(declared)).toBe(declared);
  });

  it('falls back to the data directory for an empty cwd instead of spawning in "."', async () => {
    const { resolveStdioWorkingDirectory } = await loadMcpModule();

    expect(resolveStdioWorkingDirectory('')).toBe(join(dataDir, 'mcp'));
  });

  it('never resolves inside the checkout', async () => {
    const { resolveStdioWorkingDirectory } = await loadMcpModule();
    const { resolve } = await import('node:path');

    const checkout = resolve(import.meta.dirname, '..');
    const resolved = resolveStdioWorkingDirectory(undefined);

    expect(resolved.startsWith(checkout)).toBe(false);
  });
});
