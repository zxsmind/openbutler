import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { classifyTrustedPath, trustedRootsFor } from '../src/workspace-scope.js';
import { getScratchRoot } from '../src/paths.js';

let root: string;
let project: string;
let other: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ranite-trusted-'));
  project = join(root, 'project');
  other = join(root, 'other');
  mkdirSync(project, { recursive: true });
  mkdirSync(other, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('trusted path classification', () => {
  it('treats a path under any trusted root as inside the workspace', () => {
    expect(classifyTrustedPath(join(project, 'src', 'index.ts'), [project, other])).toBe('workspace');
    expect(classifyTrustedPath(join(other, 'notes.md'), [project, other])).toBe('workspace');
  });

  it('treats a path outside every trusted root as outside', () => {
    expect(classifyTrustedPath(join(root, 'elsewhere.txt'), [project, other])).toBe('outside');
  });

  it('reports unknown when no root can be resolved', () => {
    expect(classifyTrustedPath(join(project, 'a.ts'), [join(root, 'missing-root')])).toBe('unknown');
  });

  it('includes the scratch root so throwaway work needs no prompt', () => {
    mkdirSync(getScratchRoot(), { recursive: true });
    expect(classifyTrustedPath(join(getScratchRoot(), 'probe.py'), trustedRootsFor(project))).toBe('workspace');
    expect(classifyTrustedPath(join(other, 'notes.md'), trustedRootsFor(project))).toBe('outside');
  });

  it('dates the scratch root by day so each day is discarded on its own', () => {
    const now = new Date();
    const expected = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    expect(getScratchRoot().endsWith(join('ranite', expected))).toBe(true);
  });
});
