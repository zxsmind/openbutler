import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const execAsync = promisify(execFile);
let root: string;
let child: ChildProcess;
let daemon: typeof import('../src/daemon.js');
let record: { pid: number; startedAt: string; identity: string };

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'openbutler-recovery-check-'));
  vi.stubEnv('OPENBUTLER_DATA_DIR', root);
  vi.resetModules();
  daemon = await import('../src/daemon.js');
  child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { windowsHide: true, stdio: 'ignore', cwd: root });
  await new Promise<void>((resolveSpawn, rejectSpawn) => {
    child.once('spawn', resolveSpawn);
    child.once('error', rejectSpawn);
  });
  const windows = process.platform === 'win32';
  const { stdout } = await execAsync(
    windows ? 'powershell.exe' : 'ps',
    windows
      ? [
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `$hostProcess = Get-CimInstance Win32_Process -Filter 'ProcessId = ${child.pid}'; @($hostProcess.CreationDate.ToUniversalTime().Ticks.ToString(), $hostProcess.ExecutablePath, $hostProcess.CommandLine) | ConvertTo-Json -Compress`,
        ]
      : ['-p', String(child.pid), '-o', 'lstart=', '-o', 'args='],
    { windowsHide: true, env: { ...process.env, LC_ALL: 'C' } },
  );
  record = { pid: child.pid!, startedAt: new Date().toISOString(), identity: createHash('sha256').update(stdout.trim()).digest('hex') };
  writeFileSync(join(root, 'daemon.pid'), JSON.stringify(record));
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (alive(child.pid!)) child.kill();
  await vi.waitFor(() => expect(alive(child.pid!)).toBe(false), { timeout: 3_000, interval: 25 });
  vi.unstubAllEnvs();
  if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith('openbutler-recovery-check-'))
    throw new Error('Unsafe recovery fixture cleanup path.');
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

function expireShutdownGrace() {
  const now = Date.now();
  vi.spyOn(Date, 'now')
    .mockImplementationOnce(() => now)
    .mockImplementation(() => now + 30_001);
}

it('reports an alive but unresponsive host and does not spawn a competing host', async () => {
  expect(await daemon.getDaemonStatus()).toMatchObject({ pid: child.pid, unresponsive: true });
  const before = readFileSync(join(root, 'daemon.pid'), 'utf8');
  await expect(daemon.startDaemon(root)).rejects.toThrow('Recover it with `openbutler restart`');
  expect(readFileSync(join(root, 'daemon.pid'), 'utf8')).toBe(before);
  expect(alive(child.pid!)).toBe(true);
});

it('recovers an unresponsive host only after its native process identity is verified', async () => {
  expireShutdownGrace();
  expect(await daemon.stopDaemon(true)).toBe(true);
  expect(alive(child.pid!)).toBe(false);
});

it('does not terminate a process when a stale PID record points to a different process identity', async () => {
  writeFileSync(join(root, 'daemon.pid'), JSON.stringify({ ...record, identity: 'different-process' }));
  expireShutdownGrace();
  await expect(daemon.stopDaemon(true)).rejects.toThrow('Its process identity cannot be verified');
  expect(alive(child.pid!)).toBe(true);
});
