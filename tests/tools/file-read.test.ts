import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createReadTool } from '../../src/tools/file-read.js';

let workspace: string;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'ranite-read-'));
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

describe('file_read line numbers', () => {
  it('prefixes each line with its number only when asked', async () => {
    await writeFile(join(workspace, 'note.txt'), 'alpha\nbeta\ngamma\n', 'utf8');
    const tool = createReadTool([], workspace);

    const plain = (await tool.execute!({ path: 'note.txt', offset: 2, limit: 2 }, undefined, undefined)) as Record<string, unknown>;
    expect(plain.content).toBe('beta\ngamma');
    expect(plain.lineNumbers).toBeUndefined();

    const numbered = (await tool.execute!({ path: 'note.txt', offset: 2, limit: 2, lineNumbers: true }, undefined, undefined)) as Record<
      string,
      unknown
    >;
    expect(numbered.lineNumbers).toBe(true);
    expect(numbered.content).toBe('2→beta\n3→gamma');
    expect(numbered.offset).toBe(2);
    expect(numbered.endLine).toBe(3);
  });

  it('keeps the prefix aligned to the widest line number in the page', async () => {
    const body = Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join('\n');
    await writeFile(join(workspace, 'wide.txt'), `${body}\n`, 'utf8');
    const tool = createReadTool([], workspace);
    const numbered = (await tool.execute!({ path: 'wide.txt', offset: 9, limit: 3, lineNumbers: true }, undefined, undefined)) as Record<
      string,
      unknown
    >;
    expect(numbered.content).toBe(' 9→line 9\n10→line 10\n11→line 11');
  });

  it('does not number a page that slices inside one long line', async () => {
    await writeFile(join(workspace, 'long.txt'), `${'x'.repeat(200)}\n`, 'utf8');
    const tool = createReadTool([], workspace);
    const page = (await tool.execute!({ path: 'long.txt', characterOffset: 10, lineNumbers: true }, undefined, undefined)) as Record<
      string,
      unknown
    >;
    expect(String(page.content).startsWith('→')).toBe(false);
    expect(String(page.content).startsWith('x')).toBe(true);
    expect(page.lineNumbers).toBeUndefined();
  });
});

describe('file_read directory listing', () => {
  it('returns sorted entries with types plus paging metadata', async () => {
    await mkdir(join(workspace, 'src', 'nested'), { recursive: true });
    await writeFile(join(workspace, 'src', 'a.ts'), '', 'utf8');
    await writeFile(join(workspace, 'src', 'z.md'), '', 'utf8');
    const tool = createReadTool([], workspace);

    const first = (await tool.execute!({ path: 'src', limit: 2 }, undefined, undefined)) as Record<string, unknown>;
    expect(first.status).toBe('completed');
    expect(first.offset).toBe(1);
    expect(first.totalEntries).toBe(3);
    expect(first.entries).toEqual([
      { name: 'a.ts', type: 'file', sizeBytes: 0, mtime: expect.any(String) },
      { name: 'nested', type: 'directory', sizeBytes: null, filesBytes: 0, childEntries: 0, mtime: expect.any(String) },
    ]);
    expect(first.truncated).toBe(true);

    const second = (await tool.execute!({ path: 'src', offset: 3, limit: 2 }, undefined, undefined)) as Record<string, unknown>;
    expect(second.entries).toEqual([{ name: 'z.md', type: 'file', sizeBytes: 0, mtime: expect.any(String) }]);
    expect(second.truncated).toBe(false);
  });

  it('reports file sizes, modification times, and shallow directory totals', async () => {
    await writeFile(join(workspace, 'a.txt'), 'hello', 'utf8');
    await mkdir(join(workspace, 'sub'));
    await writeFile(join(workspace, 'sub', 'b.txt'), '12345678', 'utf8');
    const tool = createReadTool([], workspace);

    const result = (await tool.execute!({ path: workspace }, undefined, undefined)) as Record<string, unknown>;
    expect(result.status).toBe('completed');
    const entries = result.entries as Array<Record<string, unknown>>;
    const byName = Object.fromEntries(entries.map((entry) => [entry.name, entry]));
    expect(byName['a.txt']).toMatchObject({ type: 'file', sizeBytes: 5 });
    expect(new Date(byName['a.txt']!.mtime as string).getTime()).not.toBeNaN();
    expect(byName['sub']).toMatchObject({ type: 'directory', sizeBytes: null, filesBytes: 8, childEntries: 1 });
    expect(new Date(byName['sub']!.mtime as string).getTime()).not.toBeNaN();
  });

  it('rejects an offset beyond the end and a characterOffset on a directory', async () => {
    await mkdir(join(workspace, 'only'), { recursive: true });
    await writeFile(join(workspace, 'only', 'one.txt'), 'x', 'utf8');
    const tool = createReadTool([], workspace);

    const beyond = (await tool.execute!({ path: 'only', offset: 5 }, undefined, undefined)) as Record<string, unknown>;
    expect(beyond.status).toBe('invalid');
    expect(beyond.entryCount).toBe(1);

    const characterOffset = (await tool.execute!({ path: 'only', characterOffset: 1 }, undefined, undefined)) as Record<string, unknown>;
    expect(characterOffset.status).toBe('invalid');
  });

  it('caps the page at the directory page size and rejects an over-limit request', async () => {
    await mkdir(join(workspace, 'page'), { recursive: true });
    for (let index = 0; index < 3; index++) await writeFile(join(workspace, 'page', `f${index}.txt`), '', 'utf8');
    const tool = createReadTool([], workspace);

    const capped = (await tool.execute!({ path: 'page', limit: 501 }, undefined, undefined)) as Record<string, unknown>;
    expect(capped.status).toBe('completed');
    expect(capped.limit).toBe(500);

    const overLimit = (await tool.execute!({ path: 'page', limit: 6_000 }, undefined, undefined)) as Record<string, unknown>;
    expect(overLimit.status).toBe('invalid');
  });
});
