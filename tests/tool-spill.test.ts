import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let dataDir: string;
let workspace: string;
let previousDataDir: string | undefined;

beforeEach(() => {
  previousDataDir = process.env.OPENBUTLER_DATA_DIR;
  dataDir = mkdtempSync(join(tmpdir(), 'openbutler-spill-data-'));
  workspace = mkdtempSync(join(tmpdir(), 'openbutler-spill-work-'));
  process.env.OPENBUTLER_DATA_DIR = dataDir;
  vi.resetModules();
});

afterEach(() => {
  if (previousDataDir === undefined) delete process.env.OPENBUTLER_DATA_DIR;
  else process.env.OPENBUTLER_DATA_DIR = previousDataDir;
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(workspace, { recursive: true, force: true });
});

describe('truncated tool results stay recoverable', () => {
  it('spills a long command output and reads the cut tail back from disk', async () => {
    const { createExecuteCommandTool } = await import('../src/tools/execute-command.js');
    const tool = createExecuteCommandTool(workspace);
    // One line per index so the tail is identifiable in the spilled file.
    const command = process.platform === 'win32' ? '1..4000 | ForEach-Object { "line-$_" }' : 'seq 1 4000 | sed "s/^/line-/';

    const result = (await tool.execute!({ command }, undefined, { sessionId: 'session-1' } as never)) as Record<string, unknown>;

    expect(result.status).toBe('completed');
    expect(result.truncated).toBe(true);
    expect(String(result.stdout).length).toBeLessThanOrEqual(8_000);
    const path = String(result.spilledTo);
    expect(path.startsWith(join(dataDir, 'tool-output'))).toBe(true);
    expect(String(result.note)).toContain(path);

    const spilled = readFileSync(path, 'utf8');
    expect(spilled).toContain('line-4000');

    // The agent reads the rest with the normal file tool, and the host treats
    // that path as pre-authorized so it never costs a prompt.
    const { createReadTool } = await import('../src/tools/file-read.js');
    const reader = createReadTool([], workspace);
    expect(reader.hostPreAuthorized?.({ path }, path)).toBe(true);
    const read = (await reader.execute!({ path, offset: 3_980, limit: 30 }, undefined, { target: path } as never)) as Record<
      string,
      unknown
    >;
    expect(read.status).toBe('completed');
    expect(String(read.content)).toContain('line-4000');
  }, 60_000);

  it('keeps a short command output inline and writes no file', async () => {
    const { createExecuteCommandTool } = await import('../src/tools/execute-command.js');
    const tool = createExecuteCommandTool(workspace);
    const result = (await tool.execute!({ command: 'echo hello' }, undefined, { sessionId: 'session-1' } as never)) as Record<
      string,
      unknown
    >;
    expect(result.truncated).toBe(false);
    expect(result.spilledTo).toBeUndefined();
    expect(String(result.stdout)).toContain('hello');
    expect(() => readdirSync(join(dataDir, 'tool-output'))).toThrow();
  });

  it('writes the full redacted result when a generic tool result is over budget', async () => {
    const { spillToolOutput, toolOutputNotice } = await import('../src/tool-output.js');
    const serialized = JSON.stringify({ payload: 'y'.repeat(40_000), tail: 'THE-END' });
    const spilled = spillToolOutput({ sessionId: 'session-1', tool: 'host:big', text: serialized });
    expect(readFileSync(spilled.path, 'utf8')).toContain('THE-END');
    expect(toolOutputNotice(spilled.path, serialized.length)).toContain('file_read');
  });
});
