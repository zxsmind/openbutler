import { existsSync, readdirSync, statSync } from 'node:fs';
import { isAbsolute, join, parse, resolve } from 'node:path';
import { ProjectInputError } from '../projects/store.js';

export interface FolderListing {
  path: string | null;
  parent: string | null;
  folders: { name: string; path: string }[];
}

function driveRoots(): { name: string; path: string }[] {
  if (process.platform === 'win32') {
    const roots: { name: string; path: string }[] = [];
    for (let code = 65; code <= 90; code += 1) {
      const letter = String.fromCharCode(code);
      const root = `${letter}:\\`;
      if (existsSync(root)) roots.push({ name: `${letter}:`, path: root });
    }
    return roots;
  }
  return [{ name: 'Computer', path: '/' }];
}

/**
 * The directories a paired browser walks when choosing a project folder. The
 * folders belong to the machine running Ranite — including remote browsers —
 * and the listing is names-and-paths only, the same exposure a native dialog
 * offered without depending on a window the background server cannot raise.
 */
export function listFolders(rawPath?: string | null): FolderListing {
  if (rawPath === undefined || rawPath === null || rawPath === '') return { path: null, parent: null, folders: driveRoots() };
  if (!isAbsolute(rawPath)) throw new ProjectInputError('Folder path must be absolute.');
  const path = resolve(rawPath);
  const root = parse(path).root;
  const atRoot = path === root || path.toLocaleLowerCase('en-US') === root.toLocaleLowerCase('en-US');
  try {
    if (!statSync(path).isDirectory()) throw new ProjectInputError(`Not a folder: ${path}`);
  } catch (error) {
    if (error instanceof ProjectInputError) throw error;
    throw new ProjectInputError(`That folder cannot be opened: ${path}`);
  }
  let entries;
  try {
    entries = readdirSync(path, { withFileTypes: true });
  } catch {
    throw new ProjectInputError(`That folder cannot be opened: ${path}`);
  }
  const folders = entries
    .filter((entry) => {
      if (entry.isDirectory()) return true;
      // A junction or symlink to a folder is a real place to work from.
      if (!entry.isSymbolicLink()) return false;
      try {
        return statSync(join(path, entry.name)).isDirectory();
      } catch {
        return false;
      }
    })
    .map((entry) => ({ name: entry.name, path: join(path, entry.name) }))
    .sort((left, right) => left.name.localeCompare(right.name));
  return { path, parent: atRoot ? null : resolve(path, '..'), folders };
}
