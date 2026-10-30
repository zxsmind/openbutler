import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The pre-rename product kept its state under `ranite` next to the new
 * `openbutler` directory. These tests pin the one-way adoption rule so an
 * upgrade cannot silently look like a fresh install.
 */
let root: string;

function layout(base: string): { current: string; legacy: string } {
  if (process.platform === 'win32') {
    return { current: join(base, 'openbutler'), legacy: join(base, 'ranite') };
  }
  if (process.platform === 'darwin') {
    const support = join(base, 'Library', 'Application Support');
    return { current: join(support, 'openbutler'), legacy: join(support, 'ranite') };
  }
  const data = join(base, 'data');
  return { current: join(data, 'openbutler'), legacy: join(data, 'ranite') };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'openbutler-paths-'));
  vi.stubEnv('OPENBUTLER_DATA_DIR', '');
  if (process.platform === 'win32') {
    vi.stubEnv('LOCALAPPDATA', root);
  } else {
    vi.stubEnv('HOME', root);
    if (process.platform === 'linux') vi.stubEnv('XDG_DATA_HOME', join(root, 'data'));
  }
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

describe('data directory', () => {
  it('adopts the pre-rename directory when the new one does not exist yet', async () => {
    const { current, legacy } = layout(root);
    mkdirSync(join(legacy, 'sessions'), { recursive: true });
    writeFileSync(join(legacy, 'settings.yaml'), 'defaultModel: test\n');

    const paths = await import('../src/paths.js');

    expect(paths.getDataDir()).toBe(current);
    expect(readFileSync(join(current, 'settings.yaml'), 'utf8')).toBe('defaultModel: test\n');
    expect(existsSync(legacy)).toBe(false);
  });

  it('keeps the current directory when both exist instead of merging them', async () => {
    const { current, legacy } = layout(root);
    mkdirSync(current, { recursive: true });
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(current, 'state.db'), 'new');
    writeFileSync(join(legacy, 'state.db'), 'old');

    const paths = await import('../src/paths.js');

    expect(paths.getDataDir()).toBe(current);
    expect(readFileSync(join(current, 'state.db'), 'utf8')).toBe('new');
    expect(readFileSync(join(legacy, 'state.db'), 'utf8')).toBe('old');
  });

  it('never moves anything when OPENBUTLER_DATA_DIR points elsewhere', async () => {
    const { legacy } = layout(root);
    const explicit = join(root, 'explicit');
    mkdirSync(legacy, { recursive: true });
    vi.stubEnv('OPENBUTLER_DATA_DIR', explicit);

    const paths = await import('../src/paths.js');

    expect(paths.getDataDir()).toBe(explicit);
    expect(existsSync(legacy)).toBe(true);
  });
});
