import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { classifyHostOwnedPath, ensureHostOwnedRoots, isForbiddenHostPath } from '../src/host-owned-paths.js';
import { getDataPath, getScratchRoot } from '../src/paths.js';
import { getMemoryPaths } from '../src/memory-paths.js';
import { getConfigPath, getSettingsPath } from '../src/settings.js';

let workspace: string;
let otherWorkspace: string;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'openbutler-host-owned-'));
  otherWorkspace = mkdtempSync(join(tmpdir(), 'openbutler-host-owned-other-'));
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
  rmSync(otherWorkspace, { recursive: true, force: true });
});

describe('classifyHostOwnedPath', () => {
  it('recognizes the memory index and user documents', () => {
    const paths = getMemoryPaths(workspace);
    expect(classifyHostOwnedPath(paths.indexFile, workspace)).toBe('memory');
    expect(classifyHostOwnedPath(paths.preferencesFile, workspace)).toBe('memory');
    expect(classifyHostOwnedPath(paths.workspaceFile, workspace)).toBe('memory');
  });

  it('refuses memory documents scoped to another workspace', () => {
    const foreign = getMemoryPaths(otherWorkspace).workspaceFile;
    expect(classifyHostOwnedPath(foreign, workspace)).toBeNull();
  });

  it('recognizes the settings file', () => {
    expect(classifyHostOwnedPath(getSettingsPath(), workspace)).toBe('settings');
  });

  it('recognizes scratch children without requiring the directory to exist', () => {
    expect(classifyHostOwnedPath(join(getScratchRoot(), 'probe.py'), workspace)).toBe('scratch');
  });

  it('leaves the rest of the data directory gated', () => {
    expect(classifyHostOwnedPath(getDataPath('tool-whitelist.json'), workspace)).toBeNull();
    expect(classifyHostOwnedPath(getDataPath('sessions'), workspace)).toBeNull();
  });

  it('returns null for ordinary workspace paths and blank input', () => {
    expect(classifyHostOwnedPath(join(workspace, 'index.ts'), workspace)).toBeNull();
    expect(classifyHostOwnedPath('   ', workspace)).toBeNull();
  });
});

describe('ensureHostOwnedRoots', () => {
  it('provisions the scratch root without throwing', () => {
    expect(() => ensureHostOwnedRoots()).not.toThrow();
    expect(existsSync(getScratchRoot())).toBe(true);
    expect(statSync(getScratchRoot()).isDirectory()).toBe(true);
  });
});

describe('isForbiddenHostPath', () => {
  it('forbids the secret store and nothing else', () => {
    const memory = getMemoryPaths(workspace);
    expect(isForbiddenHostPath(getConfigPath())).toBe(true);
    expect(isForbiddenHostPath(getSettingsPath())).toBe(false);
    expect(isForbiddenHostPath(memory.indexFile)).toBe(false);
    expect(isForbiddenHostPath(join(getScratchRoot(), 'x.py'))).toBe(false);
    expect(isForbiddenHostPath(join(workspace, 'index.ts'))).toBe(false);
    expect(isForbiddenHostPath(getDataPath('tool-whitelist.json'))).toBe(false);
  });
});
