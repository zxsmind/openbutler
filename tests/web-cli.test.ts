import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let root: string;
const spawned: ChildProcess[] = [];

// picocolors reports colour support on win32 regardless of whether stdout is a TTY, so piped CLI
// output carries SGR codes. Strip them before matching, otherwise an assertion about layout has to
// know which platform it is running on.
function plain(text: string): string {
  return text.replace(/\[[0-9;]*m/g, '');
}

function spawnCli(args: string[], extraEnv: Record<string, string> = {}): ChildProcess {
  const loader = pathToFileURL(resolve('node_modules/tsx/dist/loader.mjs')).href;
  const child = spawn(process.execPath, ['--import', loader, resolve('src/cli.ts'), ...args], {
    cwd: root,
    env: { ...process.env, RANITE_DATA_DIR: root, NO_COLOR: '1', ...extraEnv },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  spawned.push(child);
  return child;
}

/** Runs a CLI command that exits on its own and captures its piped output. */
async function runCli(args: string[], timeoutMs = 45_000): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawnCli(args);
  return new Promise((resolveRun, rejectRun) => {
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      rejectRun(new Error(`Web CLI fixture timed out: ranite ${args.join(' ')}`));
    }, timeoutMs);
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      rejectRun(error);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolveRun({ code, stdout: plain(stdout), stderr: plain(stderr) });
    });
  });
}

/** Captures a blocking CLI process's output without waiting for it to exit. */
function collect(child: ChildProcess): { done: Promise<{ code: number | null; stdout: string; stderr: string }> } {
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    stdout += chunk.toString('utf8');
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8');
  });
  const done = new Promise<{ code: number | null; stdout: string; stderr: string }>((resolveDone) => {
    child.once('exit', (code) => resolveDone({ code, stdout: plain(stdout), stderr: plain(stderr) }));
  });
  return { done };
}

function waitFor(predicate: () => boolean, timeoutMs: number, what: string): Promise<void> {
  return new Promise((resolveWait, rejectWait) => {
    const deadline = Date.now() + timeoutMs;
    const poll = () => {
      if (predicate()) return resolveWait();
      if (Date.now() > deadline) return rejectWait(new Error(`Timed out waiting for ${what}.`));
      setTimeout(poll, 100);
    };
    poll();
  });
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

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'ranite-web-cli-check-'));
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
  // Blocking pairing sessions are killed first, before the record they hold can be trusted.
  for (const child of spawned.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
  const { getDaemonStatus, stopWebProcess } = await import('../src/daemon.js');
  if (await getDaemonStatus()) {
    const stopped = await runCli(['daemon', 'stop'], 30_000);
    if (stopped.code !== 0) throw new Error(`Fixture host could not stop: ${stopped.stderr}`);
  }
  await stopWebProcess();
  vi.unstubAllEnvs();
  if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith('ranite-web-cli-check-'))
    throw new Error('Unsafe web CLI fixture cleanup path.');
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}, 60_000);

describe('ranite web pairing gate', () => {
  it('starts in the background without a pairing link and reports an existing server', async () => {
    const { webProcessStatus } = await import('../src/daemon.js');
    const booted = await runCli(['restart']);
    expect(booted.code, booted.stderr).toBe(0);
    const port = await freePort();
    const started = await runCli(['web', '--port', String(port)]);
    expect(started.code, started.stderr).toBe(0);
    expect(started.stdout).toContain('running in the background');
    expect(started.stdout).toContain(`:${port}`);
    expect(started.stdout).toContain('ranite web --pair');
    expect(started.stdout).not.toContain('one-time link');
    expect(started.stdout).not.toContain('/auth/pair');

    const record = webProcessStatus();
    expect(record?.port).toBe(port);
    const probe = await fetch(`http://127.0.0.1:${port}/`, { redirect: 'manual', signal: AbortSignal.timeout(5_000) });
    expect(probe.status).toBeLessThan(500);

    const again = await runCli(['web']);
    expect(again.code, again.stderr).toBe(0);
    expect(again.stdout).toContain('already running');
    expect(again.stdout).not.toContain('one-time link');
    expect(webProcessStatus()?.pid).toBe(record?.pid);
  }, 90_000);

  it('prints the one-time link only under --pair, tracks the session, and clears the record', async () => {
    const { webProcessStatus } = await import('../src/daemon.js');
    const booted = await runCli(['restart']);
    expect(booted.code, booted.stderr).toBe(0);
    const port = await freePort();
    const pairFile = join(root, 'pair.url');
    const child = spawnCli(['web', '--port', String(port), '--pair'], { RANITE_WEB_PAIR_FILE: pairFile });
    const session = collect(child);
    await waitFor(() => existsSync(pairFile), 60_000, 'the pairing link file');
    const link = readFileSync(pairFile, 'utf8').trim();
    expect(link).toContain(`/auth/pair?t=`);

    const record = webProcessStatus();
    expect(record?.pid).toBe(child.pid);
    expect(record?.port).toBe(port);
    const paired = await fetch(link, { redirect: 'manual', signal: AbortSignal.timeout(5_000) });
    expect(paired.status).toBeGreaterThanOrEqual(200);
    expect(paired.status).toBeLessThan(400);

    child.kill();
    const exited = await session.done;
    expect(exited.stdout).toContain('Open this one-time link');
    await waitFor(() => webProcessStatus() === null, 15_000, 'the pairing record to clear');
  }, 90_000);

  it('hands the tracked port over to a new pairing session', async () => {
    const { webProcessStatus } = await import('../src/daemon.js');
    const booted = await runCli(['restart']);
    expect(booted.code, booted.stderr).toBe(0);
    const port = await freePort();
    const started = await runCli(['web', '--port', String(port)]);
    expect(started.code, started.stderr).toBe(0);
    const backgroundPid = webProcessStatus()?.pid;
    expect(backgroundPid).toBeGreaterThan(0);

    const pairFile = join(root, 'pair.url');
    const child = spawnCli(['web', '--port', String(port), '--pair'], { RANITE_WEB_PAIR_FILE: pairFile });
    const session = collect(child);
    await waitFor(() => existsSync(pairFile), 60_000, 'the pairing link file');

    const record = webProcessStatus();
    expect(record?.pid).toBe(child.pid);
    expect(record?.port).toBe(port);
    expect(() => process.kill(backgroundPid!, 0)).toThrow();

    child.kill();
    const exited = await session.done;
    expect(exited.stdout).toContain('Stopping the tracked web server');
    await waitFor(() => webProcessStatus() === null, 15_000, 'the pairing record to clear');
  }, 120_000);
});
