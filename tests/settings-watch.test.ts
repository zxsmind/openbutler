import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { watchSettingsFiles } from '../src/settings-watch.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'openbutler-settings-watch-'));
});

afterEach(() => {
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

async function settle(ms = 150): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

describe('watchSettingsFiles', () => {
  it('fires once for a watched file, debouncing a save burst', async () => {
    const seen: string[] = [];
    const watcher = watchSettingsFiles(
      dir,
      [join(dir, 'settings.yaml')],
      () => seen.push('reloaded'),
      () => {},
      30,
    );
    try {
      writeFileSync(join(dir, 'settings.yaml'), 'a: 1\n', 'utf8');
      writeFileSync(join(dir, 'settings.yaml'), 'a: 2\n', 'utf8');
      writeFileSync(join(dir, 'settings.yaml'), 'a: 3\n', 'utf8');
      await settle();
      expect(seen).toEqual(['reloaded']);
    } finally {
      watcher.stop();
    }
  });

  it('ignores every other file in the same directory', async () => {
    const seen: string[] = [];
    const watcher = watchSettingsFiles(
      dir,
      [join(dir, 'settings.yaml')],
      () => seen.push('reloaded'),
      () => {},
      30,
    );
    try {
      writeFileSync(join(dir, 'state.db'), 'ledger-bytes', 'utf8');
      writeFileSync(join(dir, 'sessions'), 'session-bytes', 'utf8');
      await settle();
      expect(seen).toEqual([]);
    } finally {
      watcher.stop();
    }
  });

  it('stops cleanly and never calls back after stop', async () => {
    const seen: string[] = [];
    const watcher = watchSettingsFiles(
      dir,
      [join(dir, 'settings.yaml')],
      () => seen.push('reloaded'),
      () => {},
      30,
    );
    watcher.stop();
    writeFileSync(join(dir, 'settings.yaml'), 'a: 1\n', 'utf8');
    await settle();
    expect(seen).toEqual([]);
  });
});
