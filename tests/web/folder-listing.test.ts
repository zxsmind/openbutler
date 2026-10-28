import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listFolders } from '../../src/web/folder-listing.js';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ranite-folder-listing-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('listFolders', () => {
  it('offers the machine roots when nothing is chosen yet', () => {
    const listing = listFolders(undefined);
    expect(listing.path).toBeNull();
    expect(listing.parent).toBeNull();
    if (process.platform === 'win32') expect(listing.folders.some((folder) => folder.path === 'C:\\')).toBe(true);
    else expect(listing.folders).toEqual([{ name: 'Computer', path: '/' }]);
    expect(listFolders('').path).toBeNull();
  });

  it('lists child folders sorted, keeps files out, and climbs to a root parent of null', async () => {
    await mkdir(join(root, 'zeta'));
    await mkdir(join(root, 'alpha'));
    await writeFile(join(root, 'a-file.txt'), 'not a folder');
    const here = listFolders(root);
    expect(here.folders.map((folder) => folder.name)).toEqual(['alpha', 'zeta']);
    expect(here.parent).toBeTruthy();
    const seen = new Set<string>();
    let current = here;
    while (current.parent) {
      expect(seen.has(current.path!)).toBe(false);
      seen.add(current.path!);
      current = listFolders(current.parent);
    }
    expect(current.parent).toBeNull();
    expect(current.path).toMatch(process.platform === 'win32' ? /^[A-Za-z]:\\$/ : /^\/$/);
  });

  it('refuses relative paths, missing folders and plain files', async () => {
    expect(() => listFolders('relative/path')).toThrow(/absolute/);
    expect(() => listFolders(join(root, 'gone'))).toThrow(/cannot be opened/);
    const file = join(root, 'plain.txt');
    await writeFile(file, 'x');
    expect(() => listFolders(file)).toThrow(/Not a folder/);
  });
});
