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

  it('refuses an edit that would leave the file unbalanced', async () => {
    const target = await fixture('brace.ts', 'function a() {\n  return 1;\n}\n');
    const tool = createEditTool(workspace);
    const result = (await tool.execute!(
      { path: 'brace.ts', old: '  return 1;\n}\n', new: '  return 1;\n' },
      undefined,
      undefined,
    )) as Record<string, unknown>;
    expect(result.status).toBe('integrity');
    expect(String((result.errors as string[]).join(' '))).toContain('unclosed brace');
    expect(await readFile(target, 'utf8')).toBe('function a() {\n  return 1;\n}\n');
  });

  it('reports a declaration that an edit removed while its name is still used', async () => {
    const target = await fixture('ref.ts', 'const limit = 5;\nfunction read() {\n  return limit;\n}\n');
    const tool = createEditTool(workspace);
    const result = (await tool.execute!({ path: 'ref.ts', old: 'const limit = 5;\n', new: '' }, undefined, undefined)) as Record<
      string,
      unknown
    >;
    expect(result.status).toBe('completed');
    expect(String((result.integrityWarnings as string[]).join(' '))).toContain('limit');
    expect(await readFile(target, 'utf8')).toContain('return limit;');
  });

  it('refuses an edit that would introduce a BOM', async () => {
    const target = await fixture('bom.ts', 'const a = 1;\n');
    const tool = createEditTool(workspace);
    const result = (await tool.execute!(
      { path: 'bom.ts', old: 'const a = 1;', new: '\uFEFFconst a = 2;' },
      undefined,
      undefined,
    )) as Record<string, unknown>;
    expect(result.status).toBe('integrity');
    expect(await readFile(target, 'utf8')).toBe('const a = 1;\n');
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
