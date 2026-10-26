import { watch, type FSWatcher } from 'node:fs';
import { basename } from 'node:path';

export interface SettingsWatcher {
  stop(): void;
}

/**
 * Watches a directory for changes to named files and calls back debounced.
 * Only exact filename matches fire: every ledger, session, or state write in
 * the same directory is ignored. Atomic saves (temp file + rename) arrive as
 * one burst and collapse into a single call. Best-effort throughout: a dead
 * watcher logs and stops, never throws into the host.
 */
export function watchSettingsFiles(
  directory: string,
  filenames: readonly string[],
  onChange: () => void,
  log: (message: string) => void,
  debounceMs = 200,
): SettingsWatcher {
  const wanted = new Set(filenames.map((name) => basename(name)));
  let watcher: FSWatcher | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  try {
    watcher = watch(directory, (_event, filename) => {
      if (stopped || watcher === null) return;
      const changed = typeof filename === 'string' ? basename(filename) : '';
      if (!wanted.has(changed)) return;
      if (timer !== null) return;
      timer = setTimeout(() => {
        timer = null;
        if (stopped) return;
        onChange();
      }, debounceMs);
      timer.unref?.();
    });
    watcher.on('error', (error) => {
      log(`Settings watch: ${String(error)}`);
      stop();
    });
  } catch (error) {
    log(`Settings watch: ${String(error)}`);
  }
  function stop(): void {
    stopped = true;
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (watcher !== null) {
      watcher.close();
      watcher = null;
    }
  }
  return { stop };
}
