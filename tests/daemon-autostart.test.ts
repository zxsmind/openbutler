import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const commands = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawnSync: commands.run };
});

let root: string;
let entry: string;
let registryValue: string | null;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'openbutler-autostart-check-'));
  vi.stubEnv('OPENBUTLER_DATA_DIR', root);
  vi.stubEnv('OPENBUTLER_TEST_SECRET', 'must-not-be-in-launcher');
  entry = process.argv[1]!;
  process.argv[1] = join(root, 'OpenButler CLI', 'cli.js');
  registryValue = null;
  vi.resetModules();
  commands.run.mockReset();
  commands.run.mockImplementation((program: string, args: string[]) => {
    if (program !== 'reg.exe') throw new Error('Unexpected OS command in fixture.');
    if (args[0] === 'query')
      return registryValue === null
        ? { status: 1, stdout: '', stderr: 'Not found' }
        : { status: 0, stdout: `OpenButler REG_SZ ${registryValue}`, stderr: '' };
    if (args[0] === 'add') registryValue = args[args.indexOf('/d') + 1]!;
    if (args[0] === 'delete') registryValue = null;
    return { status: 0, stdout: '', stderr: '' };
  });
});
afterEach(() => {
  process.argv[1] = entry;
  vi.unstubAllEnvs();
  if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith('openbutler-autostart-check-'))
    throw new Error('Unsafe fixture cleanup path.');
  rmSync(root, { recursive: true, force: true });
});

describe('login startup Telegram wiring (cross-platform builders)', () => {
  it('embeds the token inline in the macOS agent and escapes XML', async () => {
    const service = await import('../src/daemon-autostart.js');
    const document = service.buildMacosDocument('/bin/openbutler', ['/app/cli.js', 'daemon', 'run'], '/data', '/data/daemon.log', {
      TELEGRAM_BOT_TOKEN: '123:a&b<c>',
    });
    expect(document).toContain('<key>TELEGRAM_BOT_TOKEN</key><string>123:a&amp;b&lt;c&gt;</string>');
    expect(document).toContain('<key>OPENBUTLER_DATA_DIR</key>');
    const plain = service.buildMacosDocument('/bin/openbutler', ['/app/cli.js', 'daemon', 'run'], '/data', '/data/daemon.log', {});
    expect(plain).not.toContain('TELEGRAM_BOT_TOKEN');
    expect(plain).toContain('<key>EnvironmentVariables</key><dict><key>OPENBUTLER_DATA_DIR</key><string>/data</string></dict>');
  });

  it('wires the token through an optional env file on Linux, never inline', async () => {
    const service = await import('../src/daemon-autostart.js');
    const wired = service.buildLinuxUnit('/bin/openbutler', ['/app/cli.js', 'daemon', 'run'], '/data', '/data/telegram.env');
    expect(wired).toContain('EnvironmentFile=-"/data/telegram.env"');
    expect(wired).not.toContain('123:');
    const plain = service.buildLinuxUnit('/bin/openbutler', ['/app/cli.js', 'daemon', 'run'], '/data', null);
    expect(plain).not.toContain('EnvironmentFile');
    expect(plain).toContain('Environment="OPENBUTLER_DATA_DIR=/data"');
  });

  it('puts the web binding in the login command instead of a second service', async () => {
    const service = await import('../src/daemon-autostart.js');
    const unit = service.buildLinuxUnit(
      '/bin/openbutler',
      ['/app/cli.js', 'daemon', 'run', '--web', '--port', '45278', '--hostname', '0.0.0.0', '--dir', '/work'],
      '/data',
      null,
    );
    expect(unit).toContain('"daemon" "run" "--web" "--port" "45278" "--hostname" "0.0.0.0" "--dir" "/work"');
  });

  it('rejects invalid variable names in builders', async () => {
    const service = await import('../src/daemon-autostart.js');
    expect(() => service.buildMacosDocument('/b', ['/e', 'daemon', 'run'], '/d', '/l', { 'NOPE!': 'x' })).toThrow(
      /invalid environment variable name/,
    );
  });

  it('reads the configured token from the process environment', async () => {
    const settings = await import('../src/settings.js');
    const service = await import('../src/daemon-autostart.js');
    expect(service.currentTelegramEnv()).toBeNull();
    const store = settings.defaultSettings();
    store.telegram = { enabled: true, tokenEnv: 'OPENBUTLER_TEST_TG_TOKEN', workspaceRoot: root };
    settings.saveSettings(store);
    vi.stubEnv('OPENBUTLER_TEST_TG_TOKEN', '123456:valid-token-value-here-ok');
    expect(service.currentTelegramEnv()).toEqual({ name: 'OPENBUTLER_TEST_TG_TOKEN', value: '123456:valid-token-value-here-ok' });
    const disabled = settings.defaultSettings();
    disabled.telegram = { enabled: false, tokenEnv: 'OPENBUTLER_TEST_TG_TOKEN', workspaceRoot: root };
    settings.saveSettings(disabled);
    expect(service.currentTelegramEnv()).toBeNull();
  });
});

describe.skipIf(process.platform !== 'win32')('Windows login startup Telegram wiring', () => {
  it('leaves login startup alone on Windows, where the user environment covers it', async () => {
    const service = await import('../src/daemon-autostart.js');
    expect(service.refreshAutostartEnv()).toMatchObject({ updated: false });
    expect(service.refreshAutostartEnv().detail).toMatch(/user environment/);
  });
});
describe.skipIf(process.platform !== 'win32')('user Windows automatic startup ownership', () => {
  it('quotes the compiled entry, preserves the selected data directory, and removes only its owned registration', async () => {
    const service = await import('../src/daemon-autostart.js');
    service.installAutostart();
    expect(service.isAutostartInstalled()).toBe(true);
    const launcher = join(root, 'autostart', 'openbutler-logon.vbs');
    const content = readFileSync(launcher, 'utf8');
    expect(content).toContain('OPENBUTLER_DATA_DIR');
    expect(content).toContain(root);
    expect(content).toContain('""' + process.argv[1] + '"" daemon run');
    expect(content).not.toContain('must-not-be-in-launcher');
    service.uninstallAutostart();
    expect(registryValue).toBeNull();
    expect(existsSync(launcher)).toBe(false);
  });

  it('preserves an existing foreign startup command and accepts a development TypeScript entry', async () => {
    const service = await import('../src/daemon-autostart.js');
    registryValue = 'unrelated-user-command.exe';
    expect(() => service.installAutostart()).toThrow('another command');
    service.uninstallAutostart();
    expect(registryValue).toBe('unrelated-user-command.exe');
    expect(commands.run.mock.calls.some(([, args]) => args[0] === 'delete' || args[0] === 'add')).toBe(false);
    registryValue = null;
    process.argv[1] = join(root, 'cli.ts');
    expect(() => service.installAutostart()).not.toThrow();
    const launcher = readFileSync(join(root, 'autostart', 'openbutler-logon.vbs'), 'utf8');
    expect(launcher).toContain('--import');
    expect(launcher).toContain('cli.ts');
  });

  it('writes the web binding into login startup and keeps it when only the host is reinstalled', async () => {
    const service = await import('../src/daemon-autostart.js');
    const web = { host: '0.0.0.0', port: 45278, dir: root };
    service.installAutostart({ web });
    const launcher = join(root, 'autostart', 'openbutler-logon.vbs');
    expect(readFileSync(launcher, 'utf8')).toContain('--web');
    expect(readFileSync(launcher, 'utf8')).toContain('--hostname 0.0.0.0');
    expect(readFileSync(launcher, 'utf8')).toContain('--port 45278');
    expect(readFileSync(launcher, 'utf8')).toContain('--dir');
    expect(service.readAutostartWeb()).toEqual(web);

    service.installAutostart();
    expect(readFileSync(launcher, 'utf8')).toContain('--web');

    service.installAutostart({ web: null });
    expect(readFileSync(launcher, 'utf8')).not.toContain('--web');
    expect(service.readAutostartWeb()).toBeNull();
  });

  it('cleans the generated launcher if registration fails without modifying other startup data', async () => {
    const service = await import('../src/daemon-autostart.js');
    commands.run.mockImplementation((_program: string, args: string[]) =>
      args[0] === 'query' ? { status: 1, stdout: '', stderr: 'Not found' } : { status: 5, stdout: '', stderr: 'Fixture access denied' },
    );
    expect(() => service.installAutostart()).toThrow('code 5');
    expect(existsSync(join(root, 'autostart', 'openbutler-logon.vbs'))).toBe(false);
    expect(registryValue).toBeNull();
  });
});
