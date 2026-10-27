import { createServer } from 'node:net';
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

async function freePort(): Promise<number> {
  return new Promise((resolvePort, rejectPort) => {
    const probe = createServer();
    probe.once('error', rejectPort);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close(() => resolvePort(port));
    });
  });
}

async function cli(args: string[], timeoutMs = 15_000): Promise<{ code: number | null; stdout: string; stderr: string }> {
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
      rejectChild(new Error(`Restart CLI fixture timed out: ranite ${args.join(' ')}`));
    }, timeoutMs);
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

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'ranite-restart-check-'));
  vi.stubEnv('RANITE_DATA_DIR', root);
  vi.resetModules();
  // The web child attaches a real session client, so the fixture needs a configured
  // default provider plus an offline catalog snapshot before any server can start.
  const settings = await import('../src/settings.js');
  const catalog = await import('../src/provider/catalog.js');
  catalog.writeCatalogSnapshot(
    { vercel: { npm: '@ai-sdk/gateway', models: { mimo: { tool_call: true, limit: { context: 100_000 } } } } },
    new Date().toISOString(),
  );
  const store = settings.defaultSettings();
  store.providers.vercel = { enabled: true, keys: ['fixture-a'], models: ['mimo'] };
  store.defaultProvider = 'vercel';
  store.defaultModel = 'mimo';
  settings.saveSettings(store);
});

afterEach(async () => {
  const { getDaemonStatus, stopWebProcess } = await import('../src/daemon.js');
  if (await getDaemonStatus()) {
    const stopped = await cli(['daemon', 'stop']);
    if (stopped.code !== 0) throw new Error(`Fixture host could not stop: ${stopped.stderr}`);
  }
  // A web child outlives a host that crashed mid-test; the record prunes on the next read.
  await stopWebProcess();
  vi.unstubAllEnvs();
  if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith('ranite-restart-check-'))
    throw new Error('Unsafe restart fixture cleanup path.');
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}, 60_000);

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

  it('recycles the tracked browser server with the host, keeping its port and binding', async () => {
    const { getDaemonStatus, webProcessStatus } = await import('../src/daemon.js');
    const booted = await cli(['restart']);
    expect(booted.code, booted.stderr).toBe(0);
    const port = await freePort();
    const started = await cli(['web', '--port', String(port)], 40_000);
    expect(started.code, started.stderr).toBe(0);
    expect(started.stdout).toContain('running in the background');
    expect(started.stdout).not.toContain('one-time link');
    const before = webProcessStatus();
    expect(before?.pid).toBeGreaterThan(0);
    expect(before?.port).toBe(port);

    const restarted = await cli(['restart'], 40_000);
    expect(restarted.code, restarted.stderr).toBe(0);
    expect(restarted.stdout).toContain('Background host restarted');
    expect(restarted.stdout).toContain('Web server running (pid');

    const after = webProcessStatus();
    expect(after?.pid).toBeGreaterThan(0);
    expect(after?.pid).not.toBe(before!.pid);
    expect(after?.port).toBe(port);
    expect(after?.host).toBe(before!.host);
    expect(after?.dir).toBe(before!.dir);
    expect(() => process.kill(before!.pid, 0)).toThrow();
    expect(await getDaemonStatus()).toBeTruthy();
    const probe = await fetch(`http://127.0.0.1:${port}/`, { redirect: 'manual', signal: AbortSignal.timeout(5_000) });
    expect(probe.status).toBeLessThan(500);
  }, 60_000);
});
