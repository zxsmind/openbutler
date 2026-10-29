import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { FolderPicker } from './types.js';

const run = promisify(execFile);

/** The owner cancelling `choose folder` comes back from osascript as error -128. */
const USER_CANCELLED = '(-128)';

/** macOS hands over an absolute POSIX path, so the raw output needs no fixing. */
export const macosFolderPicker: FolderPicker = async () => {
  try {
    const { stdout } = await run('osascript', ['-e', 'POSIX path of (choose folder with prompt "Choose the project source folder")'], {
      timeout: 180_000,
    });
    return stdout.trim();
  } catch (error) {
    if (String((error as { stderr?: string }).stderr).includes(USER_CANCELLED)) return null;
    throw error;
  }
};
