import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MEMORY_BODY_LIMIT_CHARS, readMemorySnapshot, stripFrontmatter } from '../src/memory-view.js';
import { getMemoryPaths } from '../src/memory-paths.js';

function note(title: string, description: string, body: string): string {
  return `---\ntitle: ${title}\ndescription: ${description}\nupdated: 2026-10-21\ntype: reference\n---\n# ${title}\n\n${body}\n`;
}

describe('memory view', () => {
  let dataDir: string;
  let previous: string | undefined;
  let paths: ReturnType<typeof getMemoryPaths>;

  beforeEach(() => {
    previous = process.env.OPENBUTLER_DATA_DIR;
    dataDir = mkdtempSync(join(tmpdir(), 'openbutler-memory-view-'));
    process.env.OPENBUTLER_DATA_DIR = dataDir;
    paths = getMemoryPaths(process.cwd());
  });

  afterEach(() => {
    if (previous === undefined) delete process.env.OPENBUTLER_DATA_DIR;
    else process.env.OPENBUTLER_DATA_DIR = previous;
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('reads each scope with its frontmatter split from the body', () => {
    mkdirSync(paths.topicsDirectory, { recursive: true });
    mkdirSync(paths.areasDirectory, { recursive: true });
    mkdirSync(join(paths.root, 'user'), { recursive: true });
    writeFileSync(paths.indexFile, '# Memory\n\n## You\n- [Preferences](user/preferences.md) — Terse. (2026-10-21)\n');
    writeFileSync(paths.preferencesFile, note('Response preferences', 'How to answer', '- Reply tersely.'));
    writeFileSync(join(paths.topicsDirectory, 'b-topic.md'), note('Second topic', 'Later alphabetically', '- b'));
    writeFileSync(join(paths.topicsDirectory, 'a-topic.md'), note('First topic', 'Earlier alphabetically', '- a'));
    writeFileSync(join(paths.areasDirectory, 'area.md'), note('An area', 'Project state', '- state'));

    const snapshot = readMemorySnapshot(process.cwd());

    expect(snapshot.index).toMatchObject({ present: true, name: 'MEMORY.md' });
    expect(snapshot.index.lines).toBeGreaterThan(1);
    expect(snapshot.files.map((file) => file.name)).toEqual([
      'user/preferences.md',
      'topics/a-topic.md',
      'topics/b-topic.md',
      'areas/area.md',
    ]);
    const preferences = snapshot.files[0]!;
    expect(preferences.group).toBe('preferences');
    expect(preferences.title).toBe('Response preferences');
    expect(preferences.description).toBe('How to answer');
    expect(preferences.updated).toBe('2026-10-21');
    // The body is what a renderer draws: no frontmatter, no metadata left behind.
    expect(preferences.body).not.toContain('---');
    expect(preferences.body).not.toContain('title:');
    expect(preferences.body).toContain('- Reply tersely.');
  });

  it('reports a missing index instead of failing', () => {
    const snapshot = readMemorySnapshot(process.cwd());
    expect(snapshot.index.present).toBe(false);
    expect(snapshot.index.bytes).toBe(0);
    expect(snapshot.files).toEqual([]);
    expect(snapshot.root).toBe(paths.root);
  });

  it('includes the workspace profile only when it exists', () => {
    mkdirSync(paths.workspaceDirectory, { recursive: true });
    writeFileSync(paths.workspaceFile, note('Workspace profile', 'Local workings', '- scratch notes'));

    const snapshot = readMemorySnapshot(process.cwd());
    const workspace = snapshot.files.find((file) => file.group === 'workspace');
    expect(workspace?.title).toBe('Workspace profile');
    expect(workspace?.scope).toBe(`workspace:${paths.workspaceKey}`);
  });

  it('cuts a body past the limit and says so', () => {
    mkdirSync(paths.topicsDirectory, { recursive: true });
    writeFileSync(join(paths.topicsDirectory, 'long.md'), note('Long note', 'Too long', 'x'.repeat(MEMORY_BODY_LIMIT_CHARS + 500)));

    const snapshot = readMemorySnapshot(process.cwd());
    const long = snapshot.files.find((file) => file.name === 'topics/long.md');
    expect(long?.truncated).toBe(true);
    expect(long?.body.length).toBe(MEMORY_BODY_LIMIT_CHARS);
  });

  it('leaves content without frontmatter untouched', () => {
    expect(stripFrontmatter('# Title\n\nBody text\n')).toBe('# Title\n\nBody text');
    expect(stripFrontmatter('---\ntitle: T\n---\nBody\n')).toBe('Body');
    // A horizontal rule deeper in the body is content, not metadata.
    expect(stripFrontmatter('Intro\n\n---\n\nAfter\n')).toBe('Intro\n\n---\n\nAfter');
  });
});
