import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let root: string;

// picocolors reports colour support on win32 regardless of whether stdout is a TTY, so piped CLI
// output carries SGR codes. Strip them before matching, otherwise an assertion about layout has to
// know which platform it is running on.
function plain(text: string): string {
  return text.replace(/\[[0-9;]*m/g, '');
}

async function cli(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const loader = pathToFileURL(resolve('node_modules/tsx/dist/loader.mjs')).href;
  return new Promise((resolveChild, rejectChild) => {
    const child = spawn(process.execPath, ['--import', loader, resolve('src/cli.ts'), ...args], {
      cwd: root,
      env: { ...process.env, RANITE_DATA_DIR: root, NO_COLOR: '1' },
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      rejectChild(new Error('Restart CLI fixture timed out.'));
    }, 15_000);
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      rejectChild(error);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolveChild({ code, stdout: plain(stdout), stderr: plain(stderr) });
    });
  });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ranite-restart-check-'));
  vi.stubEnv('RANITE_DATA_DIR', root);
  vi.resetModules();
});

afterEach(async () => {
  const { getDaemonStatus } = await import('../src/daemon.js');
  if (await getDaemonStatus()) {
    const stopped = await cli(['daemon', 'stop']);
    if (stopped.code !== 0) throw new Error(`Fixture host could not stop: ${stopped.stderr}`);
  }
  vi.unstubAllEnvs();
  if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith('ranite-restart-check-'))
    throw new Error('Unsafe restart fixture cleanup path.');
  rmSync(root, { recursive: true, force: true });
});

describe('restart CLI and detached host lifecycle', () => {
  it('starts a missing host, replaces an existing host gracefully, and exits after the new host is ready', async () => {
    const { getDaemonStatus } = await import('../src/daemon.js');
    const first = await cli(['restart']);
    expect(first.code, first.stderr).toBe(0);
    const original = await getDaemonStatus();
    expect(original?.pid).toBeGreaterThan(0);
    const restarted = await cli(['restart']);
    expect(restarted.code, restarted.stderr).toBe(0);
    expect(restarted.stdout).toContain('Background host restarted');
    const current = await getDaemonStatus();
    expect(current?.pid).toBeGreaterThan(0);
    expect(current?.pid).not.toBe(original?.pid);
    expect(() => process.kill(original!.pid, 0)).toThrow();
    expect(readFileSync(join(root, 'daemon.log'), 'utf8')).toContain('IPC restart request');
    const help = await cli(['--help']);
    expect(help.stdout).toMatch(/restart\s+Restart the background host/);
    expect(help.stdout).not.toMatch(/reload\s+Restart/);
  }, 30_000);
});
