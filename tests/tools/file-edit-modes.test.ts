import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createEditTool } from '../../src/tools/file-edit.js';

let workspace: string;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'ranite-edit-modes-'));
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

async function fixture(name: string, content: string): Promise<string> {
  const target = join(workspace, name);
  await writeFile(target, content, 'utf8');
  return target;
}

describe('file_edit modes', () => {
  it('applies several replacements in one write', async () => {
    const target = await fixture('a.ts', 'const one = 1;\nconst two = 2;\n');
    const tool = createEditTool(workspace);
    const result = (await tool.execute!(
      {
        path: 'a.ts',
        edits: [
          { old: 'one = 1', new: 'one = 10' },
          { old: 'two = 2', new: 'two = 20' },
        ],
      },
      undefined,
      undefined,
    )) as Record<string, unknown>;
    expect(result.status).toBe('completed');
    expect(result.mode).toBe('edits');
    expect(result.applied).toBe(2);
    expect(await readFile(target, 'utf8')).toBe('const one = 10;\nconst two = 20;\n');
  });

  it('refuses an ambiguous edit instead of guessing the first match', async () => {
    const target = await fixture('b.ts', 'alpha\nalpha\n');
    const tool = createEditTool(workspace);
    const result = (await tool.execute!({ path: 'b.ts', edits: [{ old: 'alpha', new: 'beta' }] }, undefined, undefined)) as Record<
      string,
      unknown
    >;
    expect(result.status).toBe('ambiguous');
    expect(result.occurrences).toBe(2);
    expect(await readFile(target, 'utf8')).toBe('alpha\nalpha\n');
  });

  it('accepts an explicit occurrence inside the batch', async () => {
    const target = await fixture('c.ts', 'alpha\nalpha\n');
    const tool = createEditTool(workspace);
    const result = (await tool.execute!(
      { path: 'c.ts', edits: [{ old: 'alpha', new: 'beta', occurrence: 2 }] },
      undefined,
      undefined,
    )) as Record<string, unknown>;
    expect(result.status).toBe('completed');
    expect(await readFile(target, 'utf8')).toBe('alpha\nbeta\n');
  });

  it('writes nothing when any edit in the batch fails', async () => {
    const target = await fixture('d.ts', 'keep me\n');
    const tool = createEditTool(workspace);
    const result = (await tool.execute!(
      {
        path: 'd.ts',
        edits: [
          { old: 'keep me', new: 'changed' },
          { old: 'not present', new: 'x' },
        ],
      },
      undefined,
      undefined,
    )) as Record<string, unknown>;
    expect(result.status).toBe('no_match');
    expect(result.edit).toBe(2);
    expect(await readFile(target, 'utf8')).toBe('keep me\n');
  });

  it('refuses overlapping edits', async () => {
    const target = await fixture('e.ts', 'abcdef\n');
    const tool = createEditTool(workspace);
    const result = (await tool.execute!(
      {
        path: 'e.ts',
        edits: [
          { old: 'abcd', new: 'X' },
          { old: 'cdef', new: 'Y' },
        ],
      },
      undefined,
      undefined,
    )) as Record<string, unknown>;
    expect(result.status).toBe('invalid');
    expect(String(result.error)).toContain('overlap');
    expect(await readFile(target, 'utf8')).toBe('abcdef\n');
  });

  it('replaces a line range when the anchor line still matches', async () => {
    const target = await fixture('f.ts', 'one\ntwo\nthree\nfour\n');
    const tool = createEditTool(workspace);
    const result = (await tool.execute!(
      { path: 'f.ts', startLine: 2, endLine: 3, anchor: 'two', newText: 'replaced' },
      undefined,
      undefined,
    )) as Record<string, unknown>;
    expect(result.status).toBe('completed');
    expect(result.mode).toBe('range');
    expect(result.linesReplaced).toBe(2);
    expect(await readFile(target, 'utf8')).toBe('one\nreplaced\nfour\n');
  });

  it('refuses a range whose anchor no longer matches, so a stale line number cannot misfire', async () => {
    const target = await fixture('g.ts', 'one\ntwo\nthree\n');
    const tool = createEditTool(workspace);
    const result = (await tool.execute!(
      { path: 'g.ts', startLine: 2, endLine: 2, anchor: 'something else', newText: 'x' },
      undefined,
      undefined,
    )) as Record<string, unknown>;
    expect(result.status).toBe('stale_range');
    expect(result.actual).toBe('two');
    expect(await readFile(target, 'utf8')).toBe('one\ntwo\nthree\n');
  });

  it('requires an anchor for range edits', async () => {
    const target = await fixture('h.ts', 'one\ntwo\n');
    const tool = createEditTool(workspace);
    const result = (await tool.execute!({ path: 'h.ts', startLine: 1, newText: 'x' }, undefined, undefined)) as Record<string, unknown>;
    expect(result.status).toBe('invalid');
    expect(await readFile(target, 'utf8')).toBe('one\ntwo\n');
  });

  it('refuses a range that runs past the end of the file', async () => {
    const target = await fixture('i.ts', 'one\ntwo\n');
    const tool = createEditTool(workspace);
    const result = (await tool.execute!(
      { path: 'i.ts', startLine: 2, endLine: 9, anchor: 'two', newText: 'x' },
      undefined,
      undefined,
    )) as Record<string, unknown>;
    expect(result.status).toBe('line_out_of_range');
    expect(await readFile(target, 'utf8')).toBe('one\ntwo\n');
  });

  it('keeps CRLF line endings when replacing a range', async () => {
    const target = await fixture('j.ts', 'one\r\ntwo\r\nthree\r\n');
    const tool = createEditTool(workspace);
    const result = (await tool.execute!(
      { path: 'j.ts', startLine: 2, endLine: 2, anchor: 'two', newText: 'two-and-a-half' },
      undefined,
      undefined,
    )) as Record<string, unknown>;
    expect(result.status).toBe('completed');
    expect(await readFile(target, 'utf8')).toBe('one\r\ntwo-and-a-half\r\nthree\r\n');
  });

  it('refuses to mix modes in one call', async () => {
    const target = await fixture('k.ts', 'one\n');
    const tool = createEditTool(workspace);
    const result = (await tool.execute!(
      { path: 'k.ts', old: 'one', new: 'two', edits: [{ old: 'one', new: 'two' }] },
      undefined,
      undefined,
    )) as Record<string, unknown>;
    expect(result.status).toBe('invalid');
    expect(await readFile(target, 'utf8')).toBe('one\n');
  });
});
