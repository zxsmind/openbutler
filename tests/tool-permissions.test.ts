import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolCallRequest } from '../src/tools/registry.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ranite-permissions-'));
  vi.stubEnv('RANITE_DATA_DIR', root);
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

const call = (input: Record<string, unknown>): ToolCallRequest =>
  ({ providerId: 'test', name: 'execute_command', input }) as unknown as ToolCallRequest;

describe('remembered permissions', () => {
  it('keeps a readable label and forgets one entry at a time', async () => {
    const { forgetRememberedPermission, isToolRequestWhitelisted, listRememberedPermissions, rememberToolRequest } =
      await import('../src/tool-permissions.js');
    const workspace = 'C:/workspace';
    rememberToolRequest(workspace, call({ command: 'npm run check' }));
    rememberToolRequest(workspace, call({ command: 'git push' }));

    expect(isToolRequestWhitelisted(workspace, call({ command: 'npm run check' }))).toBe(true);
    const remembered = listRememberedPermissions();
    expect(remembered).toHaveLength(2);
    // Newest first, and named by the call rather than by its hash.
    expect(remembered[0]?.label).toBe('execute_command: git push');
    expect(remembered[0]?.at).toBeGreaterThan(0);

    expect(forgetRememberedPermission(remembered[0]!.hash)).toBe(true);
    expect(forgetRememberedPermission(remembered[0]!.hash)).toBe(false);
    expect(listRememberedPermissions()).toHaveLength(1);
    expect(isToolRequestWhitelisted(workspace, call({ command: 'git push' }))).toBe(false);
  });

  it('still honours a version 1 allowlist of bare hashes', async () => {
    const { createHash } = await import('node:crypto');
    const { isToolRequestWhitelisted, listRememberedPermissions } = await import('../src/tool-permissions.js');
    // The fingerprint is sha256 over a stable JSON of workspace, provider, name and input.
    const payload = `{"input":{"command":"npm run check"},"name":"execute_command","providerId":"test","workspace":"C:\\\\workspace"}`;
    const hash = createHash('sha256').update(payload).digest('hex');
    writeFileSync(join(root, 'tool-whitelist.json'), JSON.stringify({ version: 1, rules: [hash] }), 'utf8');

    expect(isToolRequestWhitelisted('C:/workspace', call({ command: 'npm run check' }))).toBe(true);
    const remembered = listRememberedPermissions();
    expect(remembered).toHaveLength(1);
    expect(remembered[0]?.label).toContain('Unnamed approval');
  });
});
