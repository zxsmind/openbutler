import { isAbsolute } from 'node:path';
import { projectFolder } from '../projects/store.js';
import { folderPickerFor } from './pickers/index.js';

let picking = false;

/**
 * A folder from the machine OpenButler runs on, including when the browser lives on
 * another device. The owner picks in this platform's own dialog — the platform
 * specifics sit behind one adapter — and the chosen string is canonicalized
 * once, here, so every platform hands the caller the same promise: a full path,
 * or null when nothing was chosen.
 */
export async function pickProjectFolder(): Promise<string | null> {
  if (picking) throw new Error('A folder picker is already open.');
  picking = true;
  try {
    const picked = await folderPickerFor(process.platform)();
    if (picked === null) return null;
    // A picker that answers with a display name instead of a path is a broken
    // picker, not a broken choice: say so instead of blaming the owner's input.
    if (!isAbsolute(picked)) throw new Error('The folder picker did not return a full path. Type the folder path instead.');
    return projectFolder(picked);
  } finally {
    picking = false;
  }
}
