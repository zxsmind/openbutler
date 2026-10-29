import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * "No project" is a scope decision the backend owns: it resolves to the
 * directory the caller already owns, never to a folder the owner never chose.
 * The scratch folder is only the last resort when no scope exists at all.
 */

let dataDir: string;
let fallback: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'ranite-project-data-'));
  fallback = mkdtempSync(join(tmpdir(), 'ranite-project-launch-'));
  vi.stubEnv('RANITE_DATA_DIR', dataDir);
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(fallback, { recursive: true, force: true });
});

async function store() {
  return await import('../src/projects/store.js');
}

describe('a chat without a project takes the scope its caller owns', () => {
  it('resolves null to the fallback root instead of the scratch folder', async () => {
    const { resolveProjectSelection } = await store();
    const selection = resolveProjectSelection(null, fallback);
    expect(statSync(selection.workspaceRoot).isDirectory()).toBe(true);
    expect(selection.workspaceRoot.toLowerCase()).toBe(fallback.toLowerCase().replace(/[\\/]+$/, ''));
    expect(selection.workspaceRoot).not.toContain(join('ranite', 'workspace'));
    expect(selection.projectContext).toBeUndefined();
  });

  it('keeps a selected project ahead of any fallback', async () => {
    const { resolveProjectSelection, createProject } = await store();
    const projectDir = mkdtempSync(join(tmpdir(), 'ranite-project-folder-'));
    try {
      const project = await createProject({ name: 'Demo', folders: [projectDir] });
      const selection = resolveProjectSelection(project.id, fallback);
      expect(selection.workspaceRoot.toLowerCase()).toBe(projectDir.toLowerCase());
      expect(selection.projectContext?.name).toBe('Demo');
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('falls back to the scratch folder only when the caller owns no scope', async () => {
    const { resolveProjectSelection } = await store();
    const selection = resolveProjectSelection(null);
    expect(selection.workspaceRoot).toContain('workspace');
    expect(statSync(selection.workspaceRoot).isDirectory()).toBe(true);
  });

  it('rejects a fallback that is not a directory', async () => {
    const { resolveProjectSelection } = await store();
    const file = join(fallback, 'plain.txt');
    writeFileSync(file, 'not a folder', 'utf8');
    expect(() => resolveProjectSelection(null, file)).toThrow(/absolute folder path|not a directory|Cannot reach/i);
  });

  it('carries the fallback through sessionProject, which is what a chat persists', async () => {
    const { sessionProject } = await store();
    const project = sessionProject(null, fallback);
    expect(project.id).toBeNull();
    expect(project.workspaceRoot.toLowerCase()).toBe(fallback.toLowerCase().replace(/[\\/]+$/, ''));
  });
});
