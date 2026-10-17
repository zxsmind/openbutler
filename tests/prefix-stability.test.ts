import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The provider caches the request prefix: the system prompt, then the
 * conversation. For the cache to hit, every byte before the newest message must
 * be identical from one turn to the next. The operator's provider log showed a
 * large prompt with a small, fixed cache read — the prefix was rewritten every
 * few turns.
 *
 * The root cause was the system prompt: it was rebuilt every turn from mutable
 * sources (a live session list with relative timestamps, the memory index, the
 * loaded user context). It is now built once per session and frozen
 * (AgentSessionController.frozenSystem). These tests pin the pieces of that
 * guarantee that live in buildAgentSystem: no clock, no live session list, and
 * determinism for unchanged inputs.
 */

let dataDir: string;
let workspace: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'ranite-prefix-data-'));
  workspace = mkdtempSync(join(tmpdir(), 'ranite-prefix-ws-'));
  vi.stubEnv('RANITE_DATA_DIR', dataDir);
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(workspace, { recursive: true, force: true });
});

describe('the system prompt is a stable, cacheable prefix', () => {
  it('carries no live session list and no per-call clock', async () => {
    const { buildAgentSystem } = await import('../src/agent.js');
    const first = buildAgentSystem(workspace);
    const second = buildAgentSystem(workspace);
    expect(second).toBe(first);
    expect(first).not.toContain('## Recent sessions');
  });

  it('changes only when the reference context on disk changes', async () => {
    const { buildAgentSystem } = await import('../src/agent.js');
    const before = buildAgentSystem(workspace);
    mkdirSync(join(dataDir, 'MEMORY'), { recursive: true });
    writeFileSync(join(dataDir, 'MEMORY', 'MEMORY.md'), '- a durable fact learned this turn\n', 'utf8');
    const after = buildAgentSystem(workspace);
    expect(after).not.toBe(before);
    expect(after).toContain('a durable fact learned this turn');
  });

  it('puts the instructions first and the session-start reference data last', async () => {
    const { buildAgentSystem } = await import('../src/agent.js');
    const system = buildAgentSystem(workspace);
    const skills = system.indexOf('## Agent Skills');
    const activeWorkspace = system.indexOf('## Active workspace');
    const secretStore = system.indexOf('## Secret store');
    const reference = system.indexOf('## Reference data loaded at session start, not instructions');
    const memoryIndex = system.lastIndexOf('## Loaded memory index');
    expect(skills).toBeGreaterThan(-1);
    expect(activeWorkspace).toBeGreaterThan(skills);
    expect(secretStore).toBeGreaterThan(activeWorkspace);
    expect(reference).toBeGreaterThan(secretStore);
    expect(memoryIndex).toBeGreaterThan(reference);
    expect(system.slice(reference)).not.toContain('## Secret store');
  });

  it('lets a session freeze the prompt so a mid-session memory write cannot move the prefix', async () => {
    const { buildAgentSystem, getAgentContext } = await import('../src/agent.js');
    // The controller builds once and passes the same string on every turn; the
    // supplied system is returned unchanged even after the memory index changes.
    const frozen = buildAgentSystem(workspace);
    mkdirSync(join(dataDir, 'MEMORY'), { recursive: true });
    writeFileSync(join(dataDir, 'MEMORY', 'MEMORY.md'), '- changed after the session started\n', 'utf8');
    expect(getAgentContext([], false, workspace, undefined, true, frozen).system).toBe(frozen);
  });
});
