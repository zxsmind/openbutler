import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let directory: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'ranite-transaction-'));
  process.env.RANITE_DATA_DIR = directory;
  vi.resetModules();
});
afterEach(() => {
  delete process.env.RANITE_DATA_DIR;
});

describe('settings transaction durability', () => {
  it('publishes the settings and secrets as a pair', async () => {
    const { commitSettingsPair } = await import('../src/settings-transaction.js');
    commitSettingsPair('new-settings', 'new-secret');
    expect(readFileSync(join(directory, 'settings.yaml'), 'utf8')).toBe('new-settings');
    expect(readFileSync(join(directory, 'config.yaml'), 'utf8')).toBe('new-secret');
    expect(existsSync(join(directory, 'settings-transaction.json'))).toBe(false);
    expect(existsSync(join(directory, 'settings.lock'))).toBe(false);
  });
  it('recovers both files from the journal after an interrupted commit', async () => {
    writeFileSync(join(directory, 'settings.yaml'), 'partly committed');
    writeFileSync(join(directory, 'config.yaml'), 'old secret');
    writeFileSync(
      join(directory, 'settings-transaction.json'),
      JSON.stringify({
        version: 1,
        settings: 'new-settings',
        config: 'new-secret',
      }),
    );
    const { withSettingsLock } = await import('../src/settings-transaction.js');
    withSettingsLock(() => {});
    expect(readFileSync(join(directory, 'settings.yaml'), 'utf8')).toBe('new-settings');
    expect(readFileSync(join(directory, 'config.yaml'), 'utf8')).toBe('new-secret');
    expect(existsSync(join(directory, 'settings-transaction.json'))).toBe(false);
  });

  it('preserves the last good settings and credentials when config.yaml cannot be parsed', async () => {
    const settings = await import('../src/settings.js');
    settings.saveSettings(settings.defaultSettings());
    const previous = readFileSync(join(directory, 'settings.yaml'), 'utf8');
    writeFileSync(join(directory, 'config.yaml'), 'broken: [yaml');
    expect(() => settings.saveSettings(settings.defaultSettings())).toThrow();
    expect(readFileSync(join(directory, 'settings.yaml'), 'utf8')).toBe(previous);
    expect(readFileSync(join(directory, 'config.yaml'), 'utf8')).toBe('broken: [yaml');
  });

  it("rejects a stale settings snapshot instead of silently losing another writer's changes", async () => {
    const settings = await import('../src/settings.js');
    settings.saveSettings(settings.defaultSettings());
    const first = settings.loadSettings();
    const second = settings.loadSettings();
    first.theme = 'Dark';
    settings.saveSettings(first);
    second.theme = 'Light';
    expect(() => settings.saveSettings(second)).toThrow(/Settings changed/);
    expect(settings.loadSettings().theme).toBe('Dark');
  });

  it('preserves a separately updated team ticket during a settings save', async () => {
    const settings = await import('../src/settings.js');
    settings.saveSettings(settings.defaultSettings());
    const stale = settings.loadSettings();
    settings.saveSecrets({ providers: {}, teamTicket: 'rotated-ticket' });
    stale.theme = 'Dark';
    expect(() => settings.saveSettings(stale)).not.toThrow();
    expect(settings.loadSecrets().teamTicket).toBe('rotated-ticket');
    expect(settings.loadSettings().theme).toBe('Dark');
  });

  it('rejects stale provider keys even when the public settings file did not change', async () => {
    const settings = await import('../src/settings.js');
    const initial = settings.defaultSettings();
    initial.providers.fixture = { enabled: true, keys: ['old-key'] };
    settings.saveSettings(initial);
    const stale = settings.loadSettings();
    settings.saveSecrets({ providers: { fixture: { keys: ['new-key'] } } });
    stale.theme = 'Dark';
    expect(() => settings.saveSettings(stale)).toThrow(/Settings changed/);
    expect(settings.loadSecrets().providers.fixture?.keys).toEqual(['new-key']);
  });

  it('does not overwrite anything if the journal cannot be validated', async () => {
    writeFileSync(join(directory, 'settings.yaml'), 'untouched');
    writeFileSync(join(directory, 'settings-transaction.json'), '{invalid');
    const { withSettingsLock } = await import('../src/settings-transaction.js');
    expect(() => withSettingsLock(() => {})).toThrow();
    expect(readFileSync(join(directory, 'settings.yaml'), 'utf8')).toBe('untouched');
    expect(existsSync(join(directory, 'settings.lock'))).toBe(false);
  });
});
