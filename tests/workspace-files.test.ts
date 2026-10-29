import { basename, join } from 'node:path';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readWorkspaceFiles, WorkspaceFilesError } from '../src/web/files.js';

/**
 * The panel's scope, enforced by the host: the workspace may be listed and
 * read as before; beyond it exactly one thing answers — a single file an agent
 * cited, flagged external so the surface can show the preview as temporary.
 * No folder outside the workspace is ever enumerable.
 */

let root: string;
let outside: string;

const posix = (value: string) => value.replace(/\\/g, '/').toLowerCase();

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ranite-files-root-'));
  outside = mkdtempSync(join(tmpdir(), 'ranite-files-outside-'));
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src', 'inside.ts'), 'export const inside = 1;', 'utf8');
  writeFileSync(join(outside, 'cited.ts'), 'export const cited = 2;', 'utf8');
  mkdirSync(join(outside, 'folder'));
  writeFileSync(join(outside, 'folder', 'child.ts'), 'export const child = 3;', 'utf8');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

async function statusOf(work: Promise<unknown>): Promise<number> {
  try {
    await work;
    return 200;
  } catch (error) {
    if (error instanceof WorkspaceFilesError) return error.status;
    throw error;
  }
}

describe('the files endpoint: the workspace lists, a cited file beyond it previews', () => {
  it('serves a workspace-relative file without marking it external', async () => {
    const result = await readWorkspaceFiles(root, 'src/inside.ts');
    expect(result.kind).toBe('file');
    if (result.kind !== 'file') return;
    expect(result.path).toBe('src/inside.ts');
    expect(result.content).toContain('inside');
    expect(result.external).toBeUndefined();
  });

  it('lists a workspace folder as before', async () => {
    const result = await readWorkspaceFiles(root, 'src');
    expect(result.kind).toBe('directory');
    if (result.kind !== 'directory') return;
    expect(result.entries.map((entry) => entry.name)).toEqual(['inside.ts']);
  });

  it('keeps an absolute path that is inside the workspace absolute and unflagged', async () => {
    const target = join(root, 'src', 'inside.ts');
    const result = await readWorkspaceFiles(root, target);
    expect(result.kind).toBe('file');
    if (result.kind !== 'file') return;
    expect(posix(result.path)).toBe(posix(target));
    expect(result.external).toBeUndefined();
    expect(result.content).toContain('inside');
  });

  it('previews an absolute file outside the workspace and flags it external', async () => {
    const target = join(outside, 'cited.ts');
    const result = await readWorkspaceFiles(root, target);
    expect(result.kind).toBe('file');
    if (result.kind !== 'file') return;
    expect(result.external).toBe(true);
    expect(posix(result.path)).toBe(posix(target));
    expect(result.content).toContain('cited');
  });

  it('refuses to list an absolute folder outside the workspace', async () => {
    expect(await statusOf(readWorkspaceFiles(root, join(outside, 'folder')))).toBe(403);
  });

  it('refuses a relative path that escapes the workspace', async () => {
    const escaping = `../${basename(outside)}/cited.ts`;
    expect(await statusOf(readWorkspaceFiles(root, escaping))).toBe(403);
  });

  it('answers 404 for a cited file that no longer exists, inside or outside', async () => {
    expect(await statusOf(readWorkspaceFiles(root, join(outside, 'gone.ts')))).toBe(404);
    expect(await statusOf(readWorkspaceFiles(root, 'gone.ts'))).toBe(404);
  });
});
