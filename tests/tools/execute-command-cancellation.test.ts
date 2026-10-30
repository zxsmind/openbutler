import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, it, vi } from 'vitest';
import { createExecuteCommandTool } from '../../src/tools/execute-command.js';

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

it('cancels an exited shell even while its background child holds the output pipes open', async () => {
  const root = mkdtempSync(join(tmpdir(), 'openbutler-shell-cancel-'));
  if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith('openbutler-shell-cancel-'))
    throw new Error('Unsafe shell fixture cleanup path.');
  const holderScript = join(root, 'holder.cjs');
  const holderMarker = join(root, 'holder.pid');
  const shellMarker = join(root, 'shell.pid');
  writeFileSync(holderScript, "require('node:fs').writeFileSync(process.argv[2], String(process.pid)); setTimeout(() => {}, 8000);");
  const quote = (value: string) => `'${value.replace(/'/g, process.platform === 'win32' ? "''" : "'\\''")}'`;
  const command =
    process.platform === 'win32'
      ? `[System.IO.File]::WriteAllText(${quote(shellMarker)}, [string]$PID); Start-Process -FilePath ${quote(process.execPath)} -ArgumentList @('${'"' + holderScript + '"'}','${'"' + holderMarker + '"'}') -NoNewWindow`
      : `printf '%s' "$$" > ${quote(shellMarker)}; ${quote(process.execPath)} ${quote(holderScript)} ${quote(holderMarker)} &`;
  const abort = new AbortController();
  let settled = false;
  let holderPid: number | null = null;
  const running = createExecuteCommandTool(root)
    .execute({ command }, abort.signal)
    .finally(() => {
      settled = true;
    });
  try {
    await vi.waitFor(
      () => {
        holderPid = Number(readFileSync(holderMarker, 'utf8'));
        const shellPid = Number(readFileSync(shellMarker, 'utf8'));
        expect(alive(holderPid)).toBe(true);
        expect(alive(shellPid)).toBe(false);
      },
      { timeout: 5_000, interval: 25 },
    );
    expect(settled).toBe(false);
    abort.abort();
    const result = await Promise.race([running, delay(1_000).then(() => ({ status: 'still_waiting' }))]);
    expect(result).toMatchObject({ status: 'cancelled', error: 'Command was stopped by the user.' });
  } finally {
    abort.abort();
    if (holderPid !== null && alive(holderPid)) process.kill(holderPid);
    if (holderPid !== null) await vi.waitFor(() => expect(alive(holderPid!)).toBe(false), { timeout: 2_000, interval: 25 });
    await running;
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}, 12_000);
