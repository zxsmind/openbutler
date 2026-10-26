import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEditTool } from '../../src/tools/file-edit.js';
import { createGlobTool, createGrepTool } from '../../src/tools/file-search.js';
import { createWriteTool } from '../../src/tools/file-write.js';
import { createQuestionTool } from '../../src/tools/question.js';
import { getMemoryPaths } from '../../src/memory-paths.js';

let workspace: string;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'ranite-tools-'));
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

describe('file_edit', () => {
  it('replaces one exact occurrence and reports the match statistics', async () => {
    const target = join(workspace, 'note.txt');
    await writeFile(target, 'alpha\nbeta\nalpha\n', 'utf8');
    const tool = createEditTool(workspace);
    const result = (await tool.execute!({ path: 'note.txt', old: 'alpha', new: 'gamma' }, undefined, undefined)) as Record<string, unknown>;
    expect(result.status).toBe('completed');
    expect(result.occurrence).toBe(1);
    expect(result.occurrences).toBe(2);
    expect(result.line).toBe(1);
    expect(await readFile(target, 'utf8')).toBe('gamma\nbeta\nalpha\n');
  });

  it('replaces the requested later occurrence', async () => {
    const target = join(workspace, 'note.txt');
    await writeFile(target, 'alpha beta alpha beta', 'utf8');
    const tool = createEditTool(workspace);
    const result = (await tool.execute!({ path: 'note.txt', old: 'beta', new: 'B', occurrence: 2 }, undefined, undefined)) as Record<
      string,
      unknown
    >;
    expect(result.status).toBe('completed');
    expect(result.occurrence).toBe(2);
    expect(await readFile(target, 'utf8')).toBe('alpha beta alpha B');
  });

  it('reports missing and out-of-range matches without writing', async () => {
    const target = join(workspace, 'note.txt');
    await writeFile(target, 'alpha', 'utf8');
    const tool = createEditTool(workspace);
    const missing = (await tool.execute!({ path: 'note.txt', old: 'omega', new: 'x' }, undefined, undefined)) as Record<string, unknown>;
    expect(missing.status).toBe('no_match');
    const outOfRange = (await tool.execute!({ path: 'note.txt', old: 'alpha', new: 'x', occurrence: 3 }, undefined, undefined)) as Record<
      string,
      unknown
    >;
    expect(outOfRange.status).toBe('occurrence_out_of_range');
    expect(outOfRange.occurrences).toBe(1);
    expect(await readFile(target, 'utf8')).toBe('alpha');
  });

  it('requires an existing file and rejects an empty old value', async () => {
    const tool = createEditTool(workspace);
    const missingFile = (await tool.execute!({ path: 'absent.txt', old: 'a', new: 'b' }, undefined, undefined)) as Record<string, unknown>;
    expect(missingFile.status).toBe('invalid');
    const emptyOld = (await tool.execute!({ path: 'absent.txt', old: '', new: 'b' }, undefined, undefined)) as Record<string, unknown>;
    expect(emptyOld.status).toBe('invalid');
  });

  it('reports the unified diff and line stats of a completed edit', async () => {
    const target = join(workspace, 'note.txt');
    await writeFile(target, 'alpha\nbeta\ngamma\n', 'utf8');
    const tool = createEditTool(workspace);
    const result = (await tool.execute!({ path: 'note.txt', old: 'beta', new: 'BETA' }, undefined, undefined)) as Record<string, unknown>;
    expect(result.status).toBe('completed');
    expect(result.addedLines).toBe(1);
    expect(result.removedLines).toBe(1);
    expect(result.line).toBe(2);
  });

  it('keeps memory index structure validation on edits', async () => {
    vi.stubEnv('RANITE_DATA_DIR', join(workspace, 'data'));
    try {
      const indexFile = getMemoryPaths(workspace).indexFile;
      await mkdir(dirname(indexFile), { recursive: true });
      await writeFile(indexFile, '- note\n', 'utf8');
      const tool = createEditTool(workspace);
      const result = (await tool.execute!(
        { path: indexFile, old: '- note', new: '- [Broken](../outside.md)' },
        undefined,
        undefined,
      )) as Record<string, unknown>;
      expect(result.status).toBe('invalid_memory_index');
      expect(await readFile(indexFile, 'utf8')).toBe('- note\n');
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('file_write transcript fields', () => {
  it('reports creation with an all-addition diff', async () => {
    const tool = createWriteTool(workspace);
    const result = (await tool.execute!({ path: 'new.txt', content: 'one\ntwo\n' }, undefined, undefined)) as Record<string, unknown>;
    expect(result.status).toBe('completed');
    expect(result.created).toBe(true);
    expect(result.lineCount).toBe(3);
    expect(result.addedLines).toBe(3);
    expect(result.removedLines).toBe(0);
  });

  it('reports overwrite diffs against the previous content', async () => {
    const target = join(workspace, 'note.txt');
    await writeFile(target, 'alpha\nbeta\n', 'utf8');
    const tool = createWriteTool(workspace);
    const result = (await tool.execute!({ path: 'note.txt', content: 'alpha\nBETA\n' }, undefined, undefined)) as Record<string, unknown>;
    expect(result.status).toBe('completed');
    expect(result.created).toBe(false);
    expect(result.addedLines).toBe(1);
    expect(result.removedLines).toBe(1);
  });
});

describe('glob', () => {
  it('matches across depths and skips dependency directories', async () => {
    await mkdir(join(workspace, 'src', 'nested'), { recursive: true });
    await mkdir(join(workspace, 'node_modules', 'pkg'), { recursive: true });
    await writeFile(join(workspace, 'src', 'a.ts'), '', 'utf8');
    await writeFile(join(workspace, 'src', 'nested', 'b.ts'), '', 'utf8');
    await writeFile(join(workspace, 'node_modules', 'pkg', 'c.ts'), '', 'utf8');
    await writeFile(join(workspace, 'readme.md'), '', 'utf8');
    const tool = createGlobTool(workspace);
    const result = (await tool.execute!({ pattern: '**/*.ts' }, undefined, undefined)) as { files: string[] };
    expect(result.files.map((file) => file.replace(/\\/g, '/').replace(`${workspace.replace(/\\/g, '/')}/`, ''))).toEqual([
      'src/a.ts',
      'src/nested/b.ts',
    ]);
  });

  it('matches a bare pattern against the file name at any depth', async () => {
    await mkdir(join(workspace, 'deep', 'more'), { recursive: true });
    await writeFile(join(workspace, 'deep', 'more', 'config.json'), '', 'utf8');
    const tool = createGlobTool(workspace);
    const result = (await tool.execute!({ pattern: '*.json' }, undefined, undefined)) as { files: string[] };
    expect(result.files).toHaveLength(1);
  });

  it('reports truncation when the result cap is reached', async () => {
    for (let index = 0; index < 4; index++) await writeFile(join(workspace, `f${index}.txt`), '', 'utf8');
    const tool = createGlobTool(workspace);
    const result = (await tool.execute!({ pattern: '*.txt', max_results: 2 }, undefined, undefined)) as {
      files: string[];
      truncated: boolean;
    };
    expect(result.files).toHaveLength(2);
    expect(result.truncated).toBe(true);
  });
});

describe('grep', () => {
  it('returns structured literal matches with 1-based line numbers', async () => {
    await writeFile(join(workspace, 'code.ts'), 'first\nconst VALUE = 1;\n// VALUE again\n', 'utf8');
    const tool = createGrepTool(workspace);
    const result = (await tool.execute!({ pattern: 'VALUE', regex: false }, undefined, undefined)) as {
      matches: Array<{ line: number; text: string }>;
      matchCount: number;
    };
    expect(result.matchCount).toBe(2);
    expect(result.matches.map((match) => [match.line, match.text])).toEqual([
      [2, 'const VALUE = 1;'],
      [3, '// VALUE again'],
    ]);
  });

  it('supports regular expressions, glob filters, and result caps', async () => {
    await writeFile(join(workspace, 'a.ts'), 'id=42\nid=seven\n', 'utf8');
    await writeFile(join(workspace, 'b.md'), 'id=42\nid=42\n', 'utf8');
    const tool = createGrepTool(workspace);
    const regex = (await tool.execute!({ pattern: 'id=\\d+', regex: true }, undefined, undefined)) as { matchCount: number };
    expect(regex.matchCount).toBe(3);
    const filtered = (await tool.execute!({ pattern: 'id=', glob: '*.md', max_results: 1 }, undefined, undefined)) as {
      matches: Array<{ path: string }>;
      truncated: boolean;
    };
    expect(filtered.matches).toHaveLength(1);
    expect(filtered.matches[0]!.path.endsWith('b.md')).toBe(true);
    expect(filtered.truncated).toBe(true);
  });

  it('treats pattern as a regular expression by default and matches literally on regex false', async () => {
    await writeFile(join(workspace, 'default-mode.txt'), 'a|b\naxb\n', 'utf8');
    const tool = createGrepTool(workspace);
    const asRegex = (await tool.execute!({ pattern: 'a|b', glob: '*.txt' }, undefined, undefined)) as {
      matchCount: number;
      regex: boolean;
    };
    expect(asRegex.regex).toBe(true);
    expect(asRegex.matchCount).toBe(2);
    const asLiteral = (await tool.execute!({ pattern: 'a|b', glob: '*.txt', regex: false }, undefined, undefined)) as {
      matchCount: number;
      regex: boolean;
    };
    expect(asLiteral.regex).toBe(false);
    expect(asLiteral.matchCount).toBe(1);
  });

  it('skips binary files instead of failing the search', async () => {
    await writeFile(join(workspace, 'blob.bin'), Buffer.from([0x00, 0x01, 0x02, 0x6e, 0x65, 0x65, 0x64, 0x6c, 0x65]));
    await writeFile(join(workspace, 'text.txt'), 'needle\n', 'utf8');
    const tool = createGrepTool(workspace);
    const result = (await tool.execute!({ pattern: 'needle' }, undefined, undefined)) as { matchCount: number };
    expect(result.matchCount).toBe(1);
  });
});

describe('question', () => {
  it('returns the user answer through the interactive channel', async () => {
    const tool = createQuestionTool();
    const asked: Array<{ text: string; options?: readonly string[] }> = [];
    const result = (await tool.execute!({ question: 'Which target?', options: ['Staging', 'Production'] }, undefined, {
      ask: async (question) => {
        asked.push(question);
        return 'Staging';
      },
    })) as Record<string, unknown>;
    expect(asked).toEqual([{ text: 'Which target?', options: ['Staging', 'Production'] }]);
    expect(result).toEqual({ status: 'answered', question: 'Which target?', answer: 'Staging' });
  });

  it('reports dismissal and unavailable channels distinctly', async () => {
    const tool = createQuestionTool();
    const dismissed = (await tool.execute!({ question: 'Proceed?' }, undefined, { ask: async () => null })) as Record<string, unknown>;
    expect(dismissed.status).toBe('dismissed');
    const unavailable = (await tool.execute!({ question: 'Proceed?' }, undefined, undefined)) as Record<string, unknown>;
    expect(unavailable.status).toBe('unavailable');
  });

  it('rejects empty questions and malformed options', async () => {
    const tool = createQuestionTool();
    const empty = (await tool.execute!({ question: '   ' }, undefined, { ask: async () => 'x' })) as Record<string, unknown>;
    expect(empty.status).toBe('invalid');
    const options = (await tool.execute!({ question: 'Q', options: [] }, undefined, { ask: async () => 'x' })) as Record<string, unknown>;
    expect(options.status).toBe('invalid');
  });
});

describe('worker write lease guard', () => {
  it('file_write refuses a path another running worker holds and does not touch it', async () => {
    const tool = createWriteTool(workspace);
    const result = (await tool.execute!({ path: 'locked.txt', content: 'hello' }, undefined, {
      guardWrite: () => 'Another running subagent holds "locked.txt" until its run ends.',
    })) as Record<string, unknown>;
    expect(result).toEqual({
      status: 'denied',
      path: join(workspace, 'locked.txt'),
      error: 'Another running subagent holds "locked.txt" until its run ends.',
    });
    await expect(readFile(join(workspace, 'locked.txt'), 'utf8')).rejects.toThrow();
  });

  it('file_edit refuses a path another running worker holds and leaves the file alone', async () => {
    const target = join(workspace, 'note.txt');
    await writeFile(target, 'alpha beta', 'utf8');
    const tool = createEditTool(workspace);
    const result = (await tool.execute!({ path: 'note.txt', old: 'alpha', new: 'gamma' }, undefined, {
      guardWrite: () => 'locked by a worker',
    })) as Record<string, unknown>;
    expect(result).toMatchObject({ status: 'denied', error: 'locked by a worker' });
    expect(await readFile(target, 'utf8')).toBe('alpha beta');
  });

  it('claims the resolved path before a successful write', async () => {
    const tool = createWriteTool(workspace);
    const claimed: string[] = [];
    const result = (await tool.execute!({ path: 'free.txt', content: 'hello' }, undefined, {
      guardWrite: (path) => {
        claimed.push(path);
        return null;
      },
    })) as Record<string, unknown>;
    expect(result.status).toBe('completed');
    expect(claimed).toEqual([join(workspace, 'free.txt')]);
  });
});
