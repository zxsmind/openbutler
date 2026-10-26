import { afterEach, expect, test } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readWorkspaceFileTree } from '../../src/web/files.js';
import { buildFileTree } from '../../web/src/apps/file-tree.js';

const folders: string[] = [];
afterEach(async () => {
  await Promise.all(folders.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

test('the explorer uses real changes, respects a workspace subfolder, and filters nested paths', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ranite-file-tree-'));
  folders.push(root);
  const workspace = join(root, 'nested workspace');
  await mkdir(join(workspace, 'docs'), { recursive: true });
  await writeFile(join(root, 'outside.txt'), 'outside');
  await writeFile(join(workspace, 'docs', 'guide with spaces.md'), 'guide');
  await writeFile(join(workspace, 'new.ts'), 'new');
  const plain = await readWorkspaceFileTree(workspace);
  expect(plain.indexed).toBe(false);
  expect(plain.entries).toContainEqual({ path: 'docs', change: null, directory: true });
  const git = (args: string[]) => execFileSync('git', ['-C', root, ...args], { windowsHide: true, stdio: 'pipe' });
  git(['init', '-q']);
  git(['add', 'outside.txt', 'nested workspace/docs/guide with spaces.md']);
  const index = await readWorkspaceFileTree(workspace);
  expect(index.indexed).toBe(true);
  expect(index.entries).toEqual(
    expect.arrayContaining([
      { path: 'docs/guide with spaces.md', change: 'added' },
      { path: 'new.ts', change: 'untracked' },
    ]),
  );
  expect(index.entries.some((entry) => entry.path.includes('outside'))).toBe(false);
  const filtered = buildFileTree(index.entries, 'GUIDE WITH');
  expect(filtered).toHaveLength(1);
  expect(filtered[0]).toMatchObject({ name: 'docs', changed: true });
  expect(filtered[0].children?.[0]).toMatchObject({ name: 'guide with spaces.md', change: 'added' });
});
