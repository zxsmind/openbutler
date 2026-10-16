import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureHostOwnedRoots } from '../../src/host-owned-paths.js';
import { getScratchRoot } from '../../src/paths.js';
import { getMemoryPaths } from '../../src/memory-paths.js';
import { getConfigPath, getSettingsPath } from '../../src/settings.js';
import { createEditTool } from '../../src/tools/file-edit.js';
import { createReadTool } from '../../src/tools/file-read.js';
import { createWriteTool } from '../../src/tools/file-write.js';
import { ToolRegistry } from '../../src/tools/registry.js';

const effect = { change: 'modify', data: 'local', network: 'none', reversible: 'compensating', outbound: 'none' } as const;

let workspace: string;
let probe: string;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'ranite-host-owned-reg-'));
  probe = join(getScratchRoot(), 'host-owned-probe.txt');
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
  rmSync(probe, { force: true });
});

describe('hostPreAuthorized channel', () => {
  it('stays on when tool auto-approval is switched off', async () => {
    const registry = new ToolRegistry();
    const approve = vi.fn(async () => true);
    registry.register({
      providerId: 'host',
      name: 'owned',
      description: 'Fixture',
      inputSchema: { type: 'object', properties: {} },
      effect,
      hostPreAuthorized: () => true,
      autoApprove: () => false,
      execute: async () => ({ status: 'completed' }),
    });
    const built = await registry.createModelTools({ approve, allowToolAutoApproval: false, onResult: () => {} });
    await built.tools.owned!.execute!({}, { toolCallId: 'call-1', messages: [] });
    expect(approve).not.toHaveBeenCalled();
  });

  it('still gates tool-judgment auto-approval when switched off', async () => {
    const registry = new ToolRegistry();
    const approve = vi.fn(async () => true);
    registry.register({
      providerId: 'host',
      name: 'judged',
      description: 'Fixture',
      inputSchema: { type: 'object', properties: {} },
      effect,
      autoApprove: () => true,
      execute: async () => ({ status: 'completed' }),
    });
    const built = await registry.createModelTools({ approve, allowToolAutoApproval: false, onResult: () => {} });
    await built.tools.judged!.execute!({}, { toolCallId: 'call-2', messages: [] });
    expect(approve).toHaveBeenCalledTimes(1);
  });

  it('lets a background-style run write scratch with no approval call', async () => {
    ensureHostOwnedRoots();
    const registry = new ToolRegistry();
    const approve = vi.fn(async () => true);
    registry.register(createWriteTool(workspace));
    const built = await registry.createModelTools({ approve, allowToolAutoApproval: false, onResult: () => {} });
    const result = (await built.tools.file_write!.execute!({ path: probe, content: 'probe' }, { toolCallId: 'call-3', messages: [] })) as {
      status: unknown;
    };
    expect(approve).not.toHaveBeenCalled();
    expect(result.status).toBe('completed');
    expect(readFileSync(probe, 'utf8')).toBe('probe');
  });
});

describe('file tool pre-authorization', () => {
  it('covers memory, settings and scratch but nothing else', () => {
    const memory = getMemoryPaths(workspace);
    for (const definition of [createWriteTool(workspace), createEditTool(workspace)]) {
      expect(definition.autoApprove).toBeUndefined();
      const pre = definition.hostPreAuthorized!;
      expect(pre({ path: memory.indexFile }, undefined)).toBe(true);
      expect(pre({ path: memory.preferencesFile }, undefined)).toBe(true);
      expect(pre({ path: getSettingsPath() }, undefined)).toBe(true);
      expect(pre({ path: join(getScratchRoot(), 'x.py') }, undefined)).toBe(true);
      expect(pre({ path: join(workspace, 'index.ts') }, undefined)).toBe(false);
      expect(pre({ path: '' }, undefined)).toBe(false);
    }
  });
});

describe('secret store ban', () => {
  it('denies the config path under full access without asking', async () => {
    const registry = new ToolRegistry();
    const approve = vi.fn(async () => true);
    registry.register({
      providerId: 'host',
      name: 'reader',
      description: 'Fixture',
      inputSchema: { type: 'object', properties: {} },
      effect,
      resolveTarget: () => getConfigPath(),
      execute: async () => ({ status: 'completed' }),
    });
    const built = await registry.createModelTools({ approve, approvalMode: 'full-access', onResult: () => {} });
    const result = (await built.tools.reader!.execute!({}, { toolCallId: 'call-4', messages: [] })) as { status: unknown };
    expect(result.status).toBe('denied');
    expect(approve).not.toHaveBeenCalled();
  });

  it('denies a real file_write to the config path before anything runs', async () => {
    const registry = new ToolRegistry();
    const approve = vi.fn(async () => true);
    registry.register(createWriteTool(workspace));
    const built = await registry.createModelTools({ approve, approvalMode: 'full-access', onResult: () => {} });
    const result = (await built.tools.file_write!.execute!(
      { path: getConfigPath(), content: 'providers: {}' },
      { toolCallId: 'call-5', messages: [] },
    )) as { status: unknown; error: unknown };
    expect(result.status).toBe('denied');
    expect(String(result.error)).toContain('not visible to the agent');
    expect(approve).not.toHaveBeenCalled();
  });

  it('reads the general settings file with no approval call', async () => {
    const registry = new ToolRegistry();
    const approve = vi.fn(async () => true);
    registry.register(createReadTool([], workspace));
    const built = await registry.createModelTools({ approve, allowToolAutoApproval: false, onResult: () => {} });
    const result = (await built.tools.file_read!.execute!({ path: getSettingsPath() }, { toolCallId: 'call-6', messages: [] })) as {
      status: unknown;
    };
    expect(approve).not.toHaveBeenCalled();
    expect(result.status).toBe('completed');
  });
});
