import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createExecuteCommandTool } from '../../src/tools/execute-command.js';

/**
 * `stop()` used to kill only the shell, so a command that started its own programs
 * left them running while the ledger recorded the action as stopped. These tests pin
 * that a stop takes the tree with it — and pin the control, because a marker that
 * never appears proves nothing about which side of the test is wrong.
 *
 * The grandchild writes its marker at CHILD_WRITE_MS, well after the stop fires.
 * SETTLE_MS is the window we give it to prove it stayed dead.
 */

const CHILD_WRITE_MS = 3_000;
const SHELL_LIFETIME_MS = 6_000;
const SETTLE_MS = 5_000;
const ABORT_AT_MS = 1_200;

const sleep = (ms: number) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

let dir: string;
let marker: string;
let command: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'openbutler-tree-'));
  marker = join(dir, 'grandchild.marker');
  const seconds = CHILD_WRITE_MS / 1000;
  if (process.platform === 'win32') {
    const script = join(dir, 'child.ps1');
    writeFileSync(script, `Start-Sleep -Seconds ${seconds}\nSet-Content -Path '${marker}' -Value 'SURVIVED'\n`);
    command = `Start-Process powershell -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','${script}' -WindowStyle Hidden; Start-Sleep -Seconds ${SHELL_LIFETIME_MS / 1000}`;
  } else {
    // setsid puts the grandchild in its own group, which is what a group kill signals.
    command = `setsid sh -c 'sleep ${seconds}; echo SURVIVED > "${marker}"' & sleep ${SHELL_LIFETIME_MS / 1000}`;
  }
});

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function clearMarker(): void {
  if (existsSync(marker)) rmSync(marker, { force: true });
}

async function runUntilStopped(abortAfterMs: number | null): Promise<Record<string, unknown>> {
  const tool = createExecuteCommandTool(process.cwd());
  const controller = new AbortController();
  const timer =
    abortAfterMs === null
      ? null
      : setTimeout(() => {
          controller.abort();
        }, abortAfterMs);
  try {
    return (await tool.execute({ command }, controller.signal)) as Record<string, unknown>;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

describe('execute_command stops the whole process tree', () => {
  it('CONTROL: the grandchild runs and writes its marker when nothing stops it', async () => {
    clearMarker();
    const result = await runUntilStopped(null);
    expect(result.status).toBe('completed');
    await sleep(SETTLE_MS);
    expect(existsSync(marker), 'the grandchild never wrote its marker, so a stop cannot be proven to have killed it').toBe(true);
  }, 30_000);

  it('a cancellation takes the grandchild down with the shell', async () => {
    clearMarker();
    const result = await runUntilStopped(ABORT_AT_MS);
    expect(result.status).toBe('cancelled');
    await sleep(SETTLE_MS);
    expect(existsSync(marker), 'a process the agent started outlived the stop that was reported to the user').toBe(false);
  }, 30_000);

  it('leaves a command that finished on its own untouched', async () => {
    const tool = createExecuteCommandTool(process.cwd());
    const result = (await tool.execute({ command: process.platform === 'win32' ? 'Write-Output ok' : 'echo ok' })) as Record<
      string,
      unknown
    >;
    expect(result.status).toBe('completed');
    expect(String(result.stdout).trim()).toBe('ok');
  }, 20_000);
});
