import { open, readdir, realpath, stat } from 'node:fs/promises';
import { basename, isAbsolute, parse, relative, resolve, sep } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { FileChange, WorkspaceFiles, WorkspaceFileTree } from './files-protocol.js';

export class WorkspaceFilesError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const MAX_PREVIEW_BYTES = 256 * 1024;
const run = promisify(execFile);

/** Git supplies the workspace index and real changes without scanning ignored build/dependency trees. */
export async function readWorkspaceFileTree(workspaceRoot: string): Promise<WorkspaceFileTree> {
  const root = await realpath(workspaceRoot);
  const result: WorkspaceFileTree = {
    name: basename(root),
    rootLabel: parse(root).root.replace(/[\\/]+$/, '') || '/',
    indexed: false,
    entries: [],
  };
  const git = async (args: string[]) =>
    (
      await run('git', ['--no-optional-locks', '-C', root, ...args], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 5000,
        maxBuffer: 8 * 1024 * 1024,
      })
    ).stdout;
  try {
    const [prefix, files, status] = await Promise.all([
      git(['rev-parse', '--show-prefix']),
      git(['ls-files', '-z', '--cached', '--others', '--exclude-standard']),
      git(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', '.']),
    ]);
    const changes = new Map<string, FileChange>();
    const records = status.split('\0');
    for (let index = 0; index < records.length; index++) {
      const record = records[index];
      if (!record) continue;
      const code = record.slice(0, 2);
      const name = record.slice(3);
      if (code.includes('R') || code.includes('C')) index++; // -z emits the old name after the destination.
      if (!name.startsWith(prefix.trimEnd())) continue;
      const path = name.slice(prefix.trimEnd().length);
      if (!path || path.startsWith('../')) continue;
      changes.set(
        path,
        code === '??'
          ? 'untracked'
          : code.includes('D')
            ? 'deleted'
            : code.includes('R')
              ? 'renamed'
              : code.includes('A')
                ? 'added'
                : 'modified',
      );
    }
    const paths = new Set([...files.split('\0').filter(Boolean), ...changes.keys()]);
    result.entries = [...paths].filter((path) => !path.startsWith('../')).map((path) => ({ path, change: changes.get(path) ?? null }));
    result.indexed = true;
  } catch {
    // Outside Git, the browser uses the same lazy directory reader as before.
    result.entries = (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() || entry.isFile() || entry.isSymbolicLink())
      .map((entry) => ({ path: entry.name, change: null, directory: entry.isDirectory() }));
  }
  return result;
}

/** Read-only host files, constrained to the workspace even through symlinks. */
export async function readWorkspaceFiles(workspaceRoot: string, path: string): Promise<WorkspaceFiles> {
  try {
    if (path.length > 4096 || path.includes('\0') || isAbsolute(path))
      throw new WorkspaceFilesError(400, 'Choose a path inside this workspace.');
    const root = await realpath(workspaceRoot);
    const target = await realpath(resolve(root, path));
    const local = relative(root, target);
    if (local === '..' || local.startsWith(`..${sep}`) || isAbsolute(local))
      throw new WorkspaceFilesError(403, 'This path is outside the workspace.');
    const canonicalPath = local.split(sep).join('/');
    const name = basename(target);
    const info = await stat(target);
    if (info.isDirectory()) {
      const children = await readdir(target, { withFileTypes: true });
      const entries = children
        .filter((entry) => entry.isDirectory() || entry.isFile() || entry.isSymbolicLink())
        .map((entry) => ({
          name: entry.name,
          kind: entry.isDirectory() ? ('directory' as const) : entry.isSymbolicLink() ? ('link' as const) : ('file' as const),
        }))
        .sort(
          (left, right) =>
            Number(right.kind === 'directory') - Number(left.kind === 'directory') ||
            left.name.localeCompare(right.name, undefined, { numeric: true }),
        );
      return { kind: 'directory', path: canonicalPath, name, entries };
    }
    if (!info.isFile()) throw new WorkspaceFilesError(400, 'Only folders and regular files can be opened.');
    if (info.size > MAX_PREVIEW_BYTES)
      return { kind: 'file', path: canonicalPath, name, content: null, notice: 'This file is too large to preview (maximum 256 KB).' };
    const handle = await open(target, 'r');
    try {
      const bytes = Buffer.alloc(MAX_PREVIEW_BYTES + 1);
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
      if (bytesRead > MAX_PREVIEW_BYTES)
        return { kind: 'file', path: canonicalPath, name, content: null, notice: 'This file is too large to preview (maximum 256 KB).' };
      const data = bytes.subarray(0, bytesRead);
      let content: string | null = null;
      try {
        if (!data.includes(0)) content = new TextDecoder('utf-8', { fatal: true }).decode(data);
      } catch {
        /* Non-text files have no text preview. */
      }
      return {
        kind: 'file',
        path: canonicalPath,
        name,
        content,
        notice: content === null ? 'A text preview is not available for this file.' : null,
      };
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error instanceof WorkspaceFilesError) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') throw new WorkspaceFilesError(404, 'This file or folder no longer exists.');
    if (code === 'EACCES' || code === 'EPERM') throw new WorkspaceFilesError(403, 'The host does not allow access to this file or folder.');
    throw new WorkspaceFilesError(500, 'Could not read this file or folder.');
  }
}
