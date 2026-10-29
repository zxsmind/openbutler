import { linuxFolderPicker } from './linux.js';
import { macosFolderPicker } from './macos.js';
import type { FolderPicker } from './types.js';
import { NO_FOLDER_PICKER } from './types.js';
import { windowsFolderPicker } from './windows.js';

/**
 * The platform switch for native folder picking, and the only one: each
 * platform owns its own dialog behind the same contract, so the caller never
 * branches on `process.platform` and a new platform is one entry here.
 */
const PICKERS: Readonly<Record<string, FolderPicker>> = {
  win32: windowsFolderPicker,
  darwin: macosFolderPicker,
  linux: linuxFolderPicker,
};

/** This machine's picker, or one that explains why there is none. */
export function folderPickerFor(platform: NodeJS.Platform): FolderPicker {
  const picker = PICKERS[platform];
  return picker ?? (() => Promise.reject(new Error(NO_FOLDER_PICKER)));
}
