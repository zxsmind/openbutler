/**
 * One native folder picker for the machine Ranite runs on.
 *
 * A picker resolves to the full path the owner chose, or `null` when they
 * cancelled. It rejects when the picker could not run at all, so the caller
 * can tell "nothing was chosen" apart from "this machine has no picker".
 */
export type FolderPicker = () => Promise<string | null>;

/** Shown when the platform ships no picker: only typed paths work there. */
export const NO_FOLDER_PICKER = 'This machine has no native folder picker. Type the folder path instead.';
