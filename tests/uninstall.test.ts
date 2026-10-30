import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { findInstallDir, removeFromWindowsPath, stripInstallerPathBlock } from '../src/uninstall.js';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'openbutler-uninstall-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

it('finds the installer root from the running entry point', () => {
  mkdirSync(join(root, 'app', 'dist'), { recursive: true });
  writeFileSync(join(root, 'app', 'dist', 'cli.js'), '');
  mkdirSync(join(root, 'node'));
  mkdirSync(join(root, 'bin'));
  expect(findInstallDir(join(root, 'app', 'dist', 'cli.js'))).toBe(root);
});

it('reports no installer root for a source checkout', () => {
  mkdirSync(join(root, 'dist'));
  writeFileSync(join(root, 'dist', 'cli.js'), '');
  expect(findInstallDir(join(root, 'dist', 'cli.js'))).toBe(null);
});

it('strips the installer marker and its PATH line, keeping other content', () => {
  const binDir = '/home/u/.openbutler/bin';
  const content = `export EDITOR=vim\n\n# Added by the openbutler installer.\nexport PATH="${binDir}:$PATH"\n`;
  expect(stripInstallerPathBlock(content, binDir)).toBe('export EDITOR=vim\n');
});

it('strips a matching PATH line even without the marker', () => {
  const binDir = '/home/u/.openbutler/bin';
  const content = `export PATH="${binDir}:$PATH"\nalias ll='ls -l'\n`;
  expect(stripInstallerPathBlock(content, binDir)).toBe(`alias ll='ls -l'\n`);
});

it('keeps an unrelated line that follows the marker', () => {
  const binDir = '/home/u/.openbutler/bin';
  const content = `# Added by the openbutler installer.\nexport PATH="/other/bin:$PATH"\n`;
  expect(stripInstallerPathBlock(content, binDir)).toBe('export PATH="/other/bin:$PATH"\n');
});

it('removes only the installer entry from a Windows PATH value', () => {
  const binDir = 'C:\\Users\\x\\.openbutler\\bin';
  const value = `C:\\tools;C:\\Users\\x\\.openbutler\\bin;C:\\Windows`;
  expect(removeFromWindowsPath(value, binDir)).toBe('C:\\tools;C:\\Windows');
});

it('matches a Windows PATH entry case- and trailing-slash-insensitively', () => {
  const binDir = 'C:\\Users\\x\\.openbutler\\bin';
  const value = 'C:\\tools;c:\\USERS\\X\\.OPENBUTLER\\BIN\\';
  expect(removeFromWindowsPath(value, binDir)).toBe('C:\\tools');
});
