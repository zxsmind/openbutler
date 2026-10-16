import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getMemoryDocumentPath, getMemoryPaths, getTeamMemoryPaths, isMemoryDocumentPath } from '../src/memory-paths.js';

let dataDir: string;
let workspace: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'ranite-self-scope-'));
  workspace = mkdtempSync(join(tmpdir(), 'ranite-self-ws-'));
  process.env.RANITE_DATA_DIR = dataDir;
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(workspace, { recursive: true, force: true });
  delete process.env.RANITE_DATA_DIR;
});

describe('self and team memory scopes', () => {
  it('classifies identity, peer notes, and team files as their own scopes', () => {
    const paths = getMemoryPaths(workspace);
    expect(getMemoryDocumentPath(paths.identityFile, workspace)?.scope).toBe('self');
    expect(getMemoryDocumentPath(join(paths.peersDirectory, 'atreus.md'), workspace)?.scope).toBe('self');
    expect(getMemoryDocumentPath(getTeamMemoryPaths('myteam', workspace).decisionsFile, workspace)?.scope).toBe('team:myteam');
    expect(getMemoryDocumentPath(getTeamMemoryPaths('myteam', workspace).sharedFile, workspace)?.scope).toBe('team:myteam');
  });

  it('keeps self writable but the shared team mirror read-only', () => {
    const paths = getMemoryPaths(workspace);
    expect(isMemoryDocumentPath(paths.identityFile, workspace)).toBe(true);
    expect(isMemoryDocumentPath(join(paths.peersDirectory, 'murphy.md'), workspace)).toBe(true);
    // The shared team mirror is never a writable memory document.
    expect(isMemoryDocumentPath(getTeamMemoryPaths('myteam', workspace).sharedFile, workspace)).toBe(false);
    // A stray file directly under team/ (no team key) is not a memory document.
    expect(isMemoryDocumentPath(join(paths.teamRoot, 'stray.md'), workspace)).toBe(false);
    // Deep nesting under a team key is not a memory document either.
    expect(isMemoryDocumentPath(join(paths.teamRoot, 'myteam', 'nested', 'x.md'), workspace)).toBe(false);
  });

  it('keeps the user scope out of the team folder, so owner memory can never be synced', () => {
    // The firewall is structural: team memory lives only under team/, and the
    // sync reads only the hub's log. A user-scope path is never a team path.
    const paths = getMemoryPaths(workspace);
    const team = getTeamMemoryPaths('myteam', workspace);
    expect(paths.userFile.startsWith(team.directory)).toBe(false);
    expect(paths.topicsDirectory.startsWith(team.directory)).toBe(false);
    expect(paths.identityFile.startsWith(team.directory)).toBe(false);
    expect(team.directory.startsWith(join(paths.root, 'team'))).toBe(true);
  });

  it('materializes a peer note as a readable file (self scope is plain local files)', () => {
    const paths = getMemoryPaths(workspace);
    mkdirSync(paths.peersDirectory, { recursive: true });
    writeFileSync(join(paths.peersDirectory, 'atreus.md'), '---\ntitle: Atreus\n---\n# Atreus\n\nHandles deploys.\n', 'utf8');
    expect(isMemoryDocumentPath(join(paths.peersDirectory, 'atreus.md'), workspace)).toBe(true);
  });

  it('refuses a file write to the shared team mirror', async () => {
    const { validateTextWrite } = await import('../src/file-write-core.js');
    const team = getTeamMemoryPaths('myteam', workspace);
    const result = validateTextWrite('---\ntitle: X\n---\n# X\n\nbody\n', team.decisionsFile, workspace);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.status).toBe('read_only_memory');
  });
});
