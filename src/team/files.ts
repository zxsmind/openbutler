import { createHash } from 'node:crypto';
import { createReadStream, mkdirSync, rmSync, statSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { getDataPath } from '../paths.js';

const FILE_ID = /^f_[0-9a-f]{8,}$/;

/** The hub's on-disk file store. Bytes live here, keyed by file id; metadata lives in team.db. */
export function teamFilesDir(): string {
  return getDataPath('team-files');
}

/** Resolves a file id to its on-disk path, refusing anything that is not a file id. */
export function filePath(id: string): string {
  if (!FILE_ID.test(id)) throw new Error(`"${id}" is not a valid file id.`);
  return resolve(teamFilesDir(), id);
}

export function ensureFilesDir(): void {
  mkdirSync(teamFilesDir(), { recursive: true });
}

export function fileExists(id: string): boolean {
  try {
    return statSync(filePath(id)).isFile();
  } catch {
    return false;
  }
}

export function deleteFileBytes(id: string): void {
  rmSync(filePath(id), { force: true });
}

export function readFileStream(id: string): NodeJS.ReadableStream {
  return createReadStream(filePath(id));
}

/** Streams a local file through sha256 without loading it into memory. */
export async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(
    createReadStream(path),
    new Writable({
      write(chunk: Buffer, _encoding, callback) {
        hash.update(chunk);
        callback();
      },
    }),
  );
  return hash.digest('hex');
}

/** The default landing spot for a received file: appdata/ranite/team-inbox/<team>/<name>. */
export function defaultInboxPath(teamKey: string, name: string): string {
  return resolve(getDataPath('team-inbox'), teamKey, basename(name));
}
