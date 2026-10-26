import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { getDataPath } from './paths.js';

// Every Ranite writer participates in this process-wide, cross-process lock.
// Reads take the same lock so they cannot observe half of a two-file commit.
const LOCK_FILE = getDataPath('settings.lock');
const JOURNAL_FILE = getDataPath('settings-transaction.json');
const SETTINGS_FILE = getDataPath('settings.yaml');
const CONFIG_FILE = getDataPath('config.yaml');
const LOCK_WAIT_MS = 10_000;
const sleeper = new Int32Array(new SharedArrayBuffer(4));
let holdingLock = false;

function removeIfPresent(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

function atomicWrite(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let handle: number | undefined;
  try {
    handle = openSync(temporary, 'wx', 0o600);
    writeFileSync(handle, text, 'utf8');
    fsyncSync(handle);
    closeSync(handle);
    handle = undefined;
    renameSync(temporary, path);
  } finally {
    if (handle !== undefined) closeSync(handle);
    removeIfPresent(temporary);
  }
}

function lockOwnerIsGone(): boolean {
  let owner: number;
  try {
    const age = Date.now() - statSync(LOCK_FILE).mtimeMs;
    const raw = readFileSync(LOCK_FILE, 'utf8').trim();
    if (!/^\d+$/.test(raw)) return age > 30_000;
    owner = Number(raw);
    if (!Number.isSafeInteger(owner) || owner < 1) return age > 30_000;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
  try {
    process.kill(owner, 0);
    return false;
  } catch (error) {
    // EPERM means an existing process inaccessible to this user.
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

function recoverJournal(): void {
  if (!existsSync(JOURNAL_FILE)) return;
  const transaction: unknown = JSON.parse(readFileSync(JOURNAL_FILE, 'utf8'));
  if (
    transaction === null ||
    typeof transaction !== 'object' ||
    !('version' in transaction) ||
    transaction.version !== 1 ||
    !('settings' in transaction) ||
    typeof transaction.settings !== 'string' ||
    !('config' in transaction) ||
    typeof transaction.config !== 'string'
  ) {
    throw new Error('The settings transaction journal is invalid. No configuration was overwritten.');
  }
  atomicWrite(SETTINGS_FILE, transaction.settings);
  atomicWrite(CONFIG_FILE, transaction.config);
  removeIfPresent(JOURNAL_FILE);
}

/** Synchronous by design: reads and writes cannot interleave on the event loop. */
export function withSettingsLock<T>(operation: () => T): T {
  if (holdingLock) return operation();
  mkdirSync(dirname(LOCK_FILE), { recursive: true });
  const started = Date.now();
  let handle: number | undefined;
  while (handle === undefined) {
    try {
      handle = openSync(LOCK_FILE, 'wx', 0o600);
      writeFileSync(handle, String(process.pid), 'utf8');
      closeSync(handle);
      handle = undefined;
      break;
    } catch (error) {
      if (handle !== undefined) {
        closeSync(handle);
        handle = undefined;
      }
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (lockOwnerIsGone()) {
        removeIfPresent(LOCK_FILE);
        continue;
      }
      if (Date.now() - started > LOCK_WAIT_MS) throw new Error('Timed out waiting for the settings transaction lock.');
      Atomics.wait(sleeper, 0, 0, 25);
    }
  }
  holdingLock = true;
  try {
    recoverJournal();
    return operation();
  } finally {
    holdingLock = false;
    removeIfPresent(LOCK_FILE);
  }
}

/** Commit two YAML files as one logical transaction, including crash recovery. */
export function commitSettingsPair(settings: string, config: string): void {
  withSettingsLock(() => {
    atomicWrite(JOURNAL_FILE, JSON.stringify({ version: 1, settings, config }));
    recoverJournal();
  });
}

/** Single-file secret updates use the same serialization boundary. */
export function commitSecrets(config: string): void {
  withSettingsLock(() => atomicWrite(CONFIG_FILE, config));
}
