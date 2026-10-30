import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream, mkdirSync, rmSync, statSync } from 'node:fs';
import { link, rename, rm } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { Writable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { getDataPath } from '../paths.js';
import { TeamTransportError } from './contracts.js';

/** Every receive path verifies bytes before atomically replacing its destination. */
export async function writeVerifiedFile(
  source: NodeJS.ReadableStream,
  destination: string,
  expected: { size: number; sha256: string },
  signal?: AbortSignal,
): Promise<void> {
  mkdirSync(dirname(destination), { recursive: true });
  const temporary = `${destination}.${randomUUID()}.part`;
  const hash = createHash('sha256');
  let received = 0;
  const meter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      received += chunk.length;
      if (received > expected.size) return callback(new TeamTransportError('File exceeds the declared size.', false, 400));
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  try {
    await pipeline(source, meter, createWriteStream(temporary), { signal });
    if (received !== expected.size || hash.digest('hex') !== expected.sha256)
      throw new TeamTransportError('File bytes do not match the declared size or sha256.', false, 400);
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true });
  }
}

/** Publish immutable hub bytes without overwriting an already committed transfer id. */
export async function storeFileBytes(source: NodeJS.ReadableStream, id: string, expected: { size: number; sha256: string }): Promise<void> {
  ensureFilesDir();
  const destination = filePath(id);
  const staged = `${destination}.${randomUUID()}.upload`;
  try {
    await writeVerifiedFile(source, staged, expected);
    try {
      await link(staged, destination);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (statSync(destination).size !== expected.size || (await hashFile(destination)) !== expected.sha256)
        throw new TeamTransportError('Transfer id already has different bytes.', false, 409);
    }
  } finally {
    await rm(staged, { force: true });
  }
}

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

/** Outbound bytes are derived from their identity, never from a path supplied by a queue document. */
export function outboundFilePath(id: string): string {
  if (!FILE_ID.test(id)) throw new Error(`"${id}" is not a valid file id.`);
  return resolve(getDataPath('team-outbound-files'), id);
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

/** The default landing spot for a received file: appdata/openbutler/team-inbox/<team>/<name>. */
export function defaultInboxPath(teamKey: string, name: string): string {
  return resolve(getDataPath('team-inbox'), teamKey, basename(name));
}
