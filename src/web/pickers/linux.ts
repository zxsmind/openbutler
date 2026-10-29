import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { FolderPicker } from './types.js';
import { NO_FOLDER_PICKER } from './types.js';

const run = promisify(execFile);

/** zenity closes the dialog with exit code 1 and prints nothing. */
const DIALOG_CLOSED = 1;

/**
 * zenity prints the full path; a machine without it (headless, or a desktop
 * that ships another dialog) has no picker, and the owner types the path.
 */
export const linuxFolderPicker: FolderPicker = async () => {
  try {
    const { stdout } = await run('zenity', ['--file-selection', '--directory', '--title=Choose the project source folder'], {
      timeout: 180_000,
    });
    return stdout.trim();
  } catch (error) {
    if ((error as { code?: number | string }).code === DIALOG_CLOSED) return null;
    if ((error as { code?: number | string }).code === 'ENOENT') throw new Error(NO_FOLDER_PICKER);
    throw error;
  }
};
