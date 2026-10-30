import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let dataDir: string;
let previousDataDir: string | undefined;

beforeEach(() => {
  previousDataDir = process.env.OPENBUTLER_DATA_DIR;
  dataDir = mkdtempSync(join(tmpdir(), 'openbutler-tool-output-'));
  process.env.OPENBUTLER_DATA_DIR = dataDir;
  vi.resetModules();
});

afterEach(() => {
  if (previousDataDir === undefined) delete process.env.OPENBUTLER_DATA_DIR;
  else process.env.OPENBUTLER_DATA_DIR = previousDataDir;
  rmSync(dataDir, { recursive: true, force: true });
});

describe('tool output spill', () => {
  it('writes the complete text and hands back a readable path', async () => {
    const { spillToolOutput, getToolOutputRoot } = await import('../src/tool-output.js');
    const text = 'x'.repeat(50_000);
    const spilled = spillToolOutput({ sessionId: 'abcdef12-3456', tool: 'host:execute_command', text });

    expect(spilled.path.startsWith(getToolOutputRoot())).toBe(true);
    expect(spilled.savedChars).toBe(text.length);
    expect(spilled.droppedChars).toBe(0);
    expect(readFileSync(spilled.path, 'utf8')).toBe(text);
  });

  it('names the file so the tool and session can be recognized', async () => {
    const { spillToolOutput } = await import('../src/tool-output.js');
    const spilled = spillToolOutput({ sessionId: 'abcdef12-3456', tool: 'mcp-athena:athena_search', text: 'x' });
    expect(spilled.path).toMatch(/abcdef12-mcp-athena-athena_search-[0-9a-f]{8}\.log$/);
  });

  it('reports the notice that tells the model how to read the rest', async () => {
    const { toolOutputNotice } = await import('../src/tool-output.js');
    const notice = toolOutputNotice('/tmp/out.log', 240_000);
    expect(notice).toContain('/tmp/out.log');
    expect(notice).toContain('240,000');
    expect(notice).toContain('file_read');
  });

  it('deletes files past the retention window and keeps fresh ones', async () => {
    const { pruneToolOutput, getToolOutputRoot, TOOL_OUTPUT_RETENTION_MS } = await import('../src/tool-output.js');
    const root = getToolOutputRoot();
    mkdirSync(root, { recursive: true });
    const old = join(root, 'old.log');
    const fresh = join(root, 'fresh.log');
    writeFileSync(old, 'old');
    writeFileSync(fresh, 'fresh');
    const past = (Date.now() - TOOL_OUTPUT_RETENTION_MS - 60_000) / 1000;
    utimesSync(old, past, past);

    pruneToolOutput(Date.now(), { force: true });
    expect(readdirSync(root)).toEqual(['fresh.log']);
  });

  it('trims the directory to its byte budget, oldest first', async () => {
    const { pruneToolOutput, getToolOutputRoot } = await import('../src/tool-output.js');
    const root = getToolOutputRoot();
    mkdirSync(root, { recursive: true });
    // Two megabytes of spill files against a one-megabyte budget.
    const names = Array.from({ length: 8 }, (_, index) => join(root, `part-${index}.log`));
    names.forEach((path, index) => {
      writeFileSync(path, 'x'.repeat(256 * 1024));
      const stamp = (Date.now() - (names.length - index) * 60_000) / 1000;
      utimesSync(path, stamp, stamp);
    });

    pruneToolOutput(Date.now(), { force: true, maxBytes: 1024 * 1024 });
    const kept = readdirSync(root).sort();
    expect(kept.length).toBeLessThanOrEqual(4);
    // The oldest files are the ones that went.
    expect(kept).not.toContain('part-0.log');
    expect(kept).toContain('part-7.log');
  });
});
