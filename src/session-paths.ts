import { existsSync, lstatSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { getDataPath } from './paths.js';
import { isWithinPhysicalDirectory } from './workspace-scope.js';

/** One session owns its transcript and attachments in the same directory. */
export const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const sessionsDirectory = () => getDataPath('sessions');
export function sessionDirectory(id: string): string {
  if (!SESSION_ID.test(id)) throw new Error('Invalid session id.');
  return join(sessionsDirectory(), id);
}
export const sessionFilePath = (id: string) => join(sessionDirectory(id), `${id}.json`);
export const sessionAttachmentsDirectory = (id: string) => join(sessionDirectory(id), 'attachments');
export function ensureSessionDirectory(id: string): string {
  const root = sessionsDirectory();
  mkdirSync(root, { recursive: true });
  const target = sessionDirectory(id);
  if (!isWithinPhysicalDirectory(target, root) || (existsSync(target) && lstatSync(target).isSymbolicLink()))
    throw new Error('Session directory escapes its storage root.');
  mkdirSync(target, { recursive: true });
  return target;
}
export function ensureSessionAttachmentsDirectory(id: string): string {
  const root = ensureSessionDirectory(id);
  const target = sessionAttachmentsDirectory(id);
  if (!isWithinPhysicalDirectory(target, root) || (existsSync(target) && lstatSync(target).isSymbolicLink()))
    throw new Error('Attachment directory escapes its session.');
  mkdirSync(target, { recursive: true });
  return target;
}
export function legacySessionFilePath(id: string): string {
  if (!SESSION_ID.test(id)) throw new Error('Invalid session id.');
  return join(sessionsDirectory(), `${id}.json`);
}
/** Old flat files are read only until the session is next saved in its directory. */
export function savedSessionFilePath(id: string): string {
  const current = sessionFilePath(id);
  return existsSync(current) ? current : legacySessionFilePath(id);
}
