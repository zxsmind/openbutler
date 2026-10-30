import { mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { getMemoryDocumentPath, getMemoryPaths, isMemoryDocumentPath, isMemoryIndexPath } from '../src/memory-paths.js';
import { migrateMemoryLayout } from '../src/memory-layout.js';
import { parseMemoryDocument, validateMemoryDocument, validateMemoryIndex } from '../src/memory-document.js';
import { ensureMemoryIndexEntry } from '../src/file-write-core.js';
import { createWriteTool } from '../src/tools/file-write.js';
import { getAgentContext } from '../src/agent.js';

let root: string;
let workspace: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'openbutler-memory-contract-test-'));
  workspace = join(root, 'workspace');
  mkdirSync(workspace);
  vi.stubEnv('OPENBUTLER_DATA_DIR', join(root, 'data'));
});
afterEach(async () => {
  vi.unstubAllEnvs();
  if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith('openbutler-memory-contract-test-'))
    throw new Error('Unsafe memory fixture cleanup path.');
  await rm(root, { recursive: true, force: true });
});

const note = `---
type: feedback
title: Working Preferences
description: User preferences about temporary working files.
updated: 2026-10-11
---
# Working Preferences

Use the operating system temporary directory for research scripts, and remove temporary artifacts after the task is complete.

- Research scripts live in the OS temporary directory.
- Remove temporary artifacts after the task is complete. (Explicit user correction.)
`;
function put(path: string, content: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

it('puts profiles beside their scoped notes and keeps other workspaces outside automatic access', () => {
  const paths = getMemoryPaths(workspace);
  expect(paths.userFile).toBe(join(paths.root, 'user', 'profile.md'));
  expect(paths.preferencesFile).toBe(join(paths.root, 'user', 'preferences.md'));
  expect(paths.workspaceFile).toBe(join(paths.root, 'workspaces', paths.workspaceKey, 'profile.md'));
  expect(paths.topicsDirectory).toBe(join(paths.root, 'topics'));
  expect(paths.areasDirectory).toBe(join(paths.root, 'areas'));
  const other = join(root, 'another-workspace');
  mkdirSync(other);
  expect(isMemoryDocumentPath(getMemoryPaths(other).workspaceFile, workspace)).toBe(false);
  expect(getMemoryDocumentPath(getMemoryPaths(other).workspaceFile, workspace)?.scope).not.toBe('user');
});

it('migrates old profiles and nested topics without changing note contents; a second run does nothing', () => {
  const paths = getMemoryPaths(workspace);
  put(join(paths.root, 'user.md'), 'Exact old user preference.');
  put(join(paths.root, 'user', 'feedback', 'working-files.md'), note);
  put(join(paths.root, paths.workspaceKey, 'workspace.md'), 'Exact workspace facts.');
  put(join(paths.root, paths.workspaceKey, 'topics', 'issue.md'), 'Exact prior issue.');
  put(
    paths.indexFile,
    '# Memory Index\n- [User](user.md) — response preference\n- [Files](user/feedback/working-files.md) — file preference\n',
  );
  const migrated = migrateMemoryLayout(workspace);
  expect(migrated.moved).toHaveLength(5);
  expect(readFileSync(paths.userFile, 'utf8')).toBe('Exact old user preference.');
  expect(readFileSync(paths.workspaceFile, 'utf8')).toBe('Exact workspace facts.');
  expect(readFileSync(join(paths.topicsDirectory, 'feedback', 'working-files.md'), 'utf8')).toBe(note);
  expect(readFileSync(join(paths.areasDirectory, 'issue.md'), 'utf8')).toBe('Exact prior issue.');
  expect(readFileSync(paths.indexFile, 'utf8')).toContain('(user/profile.md)');
  expect(readFileSync(paths.indexFile, 'utf8')).toContain('(topics/feedback/working-files.md)');
  expect(migrateMemoryLayout(workspace).moved).toEqual([]);
});

it('rewrites moved memory links while leaving inline and fenced code examples untouched', () => {
  const paths = getMemoryPaths(workspace);
  const oldNote = `# Legacy note\n\n[Profile](../../user.md) and \`[example](../../user.md)\`.\n\n~~~md\n[example](../../user.md)\n~~~\n`;
  put(join(paths.root, 'user.md'), '# Legacy user profile');
  put(join(paths.root, 'user', 'feedback', 'links.md'), oldNote);
  put(paths.indexFile, '# Memory Index\n- [Profile](user.md) — shared user facts\n');
  migrateMemoryLayout(workspace);
  const migrated = readFileSync(join(paths.topicsDirectory, 'feedback', 'links.md'), 'utf8');
  expect(migrated).toContain('[Profile](../../user/profile.md)');
  expect(migrated).toContain('`[example](../../user.md)`');
  expect(migrated).toContain('~~~md\n[example](../../user.md)\n~~~');
  expect(readFileSync(paths.indexFile, 'utf8')).toContain('(user/profile.md)');
});

it('preserves both versions when a canonical profile and a different legacy profile exist', () => {
  const paths = getMemoryPaths(workspace);
  put(paths.userFile, 'Current canonical profile.');
  put(join(paths.root, 'user.md'), 'Distinct legacy facts.');
  const result = migrateMemoryLayout(workspace);
  expect(result.conflicts).toHaveLength(1);
  expect(result.conflicts[0]).toContain('.migration');
  expect(result.conflicts[0]).toContain('conflicts');
  expect(readFileSync(paths.userFile, 'utf8')).toBe('Current canonical profile.');
  expect(readFileSync(result.conflicts[0]!, 'utf8')).toBe('Distinct legacy facts.');
  expect(migrateMemoryLayout(workspace).moved).toEqual([]);
});

it('does not grant automatic memory access through a directory link outside the memory root', () => {
  const paths = getMemoryPaths(workspace);
  mkdirSync(paths.topicsDirectory, { recursive: true });
  const external = join(root, 'external');
  mkdirSync(external);
  symlinkSync(external, join(paths.topicsDirectory, 'external'), process.platform === 'win32' ? 'junction' : 'dir');
  expect(isMemoryDocumentPath(join(paths.topicsDirectory, 'external', 'note.md'), workspace)).toBe(false);
});

it('validates new note structure before replacing the canonical file, while ordinary workspace files remain generic', async () => {
  const paths = getMemoryPaths(workspace);
  const path = join(paths.topicsDirectory, 'working-preferences.md');
  put(path, note);
  const tool = createWriteTool(workspace);
  expect(await tool.execute({ path, content: '# A flat replacement\nNo metadata.' })).toMatchObject({ status: 'invalid_memory_format' });
  expect(readFileSync(path, 'utf8')).toBe(note);
  expect(await tool.execute({ path: join(paths.root, 'user.md'), content: note })).toMatchObject({ status: 'invalid_memory_path' });
  expect(await tool.execute({ path: join(paths.topicsDirectory, 'Poor_Name.md'), content: note })).toMatchObject({
    status: 'invalid_memory_path',
  });
  expect(await tool.execute({ path: join(workspace, 'README.md'), content: '# Ordinary file' })).toMatchObject({ status: 'completed' });
  expect(await tool.execute({ path, content: note.replace('Explicit user correction.', 'Recorded user correction.') })).toMatchObject({
    status: 'completed',
  });
});

it('rejects broken global-index links and accepts a real shared-user note', async () => {
  const paths = getMemoryPaths(workspace);
  const tool = createWriteTool(workspace);
  const broken = '# Memory Index\n- [Preferences](topics/preferences.md) — communication preferences\n';
  expect(await tool.execute({ path: paths.indexFile, content: broken })).toMatchObject({ status: 'invalid_memory_index' });
  put(join(paths.topicsDirectory, 'preferences.md'), note);
  const dated = '# Memory Index\n- [Preferences](topics/preferences.md) — communication preferences (2026-10-11)\n';
  expect(await tool.execute({ path: paths.indexFile, content: dated })).toMatchObject({ status: 'completed' });
});

it('links every user-scope write from MEMORY.md exactly once and keeps the workspace profile out of it', async () => {
  const paths = getMemoryPaths(workspace);
  const tool = createWriteTool(workspace);
  const notePath = join(paths.topicsDirectory, 'working-preferences.md');
  expect(await tool.execute({ path: notePath, content: note })).toMatchObject({ status: 'completed', memoryIndexEntry: 'added' });
  const index = readFileSync(paths.indexFile, 'utf8');
  expect(index).toMatch(
    /- \[Working Preferences\]\(topics\/working-preferences\.md\) — User preferences about temporary working files\. \(\d{4}-\d{2}-\d{2}\)/,
  );
  expect(
    await tool.execute({ path: notePath, content: note.replace('Explicit user correction.', 'Recorded user correction.') }),
  ).toMatchObject({
    status: 'completed',
  });
  expect(await tool.execute({ path: notePath, content: note })).not.toMatchObject({ memoryIndexEntry: 'added' });
  expect(readFileSync(paths.indexFile, 'utf8').match(/topics\/working-preferences\.md/g)).toHaveLength(1);
  const workspaceProfile = note
    .replace('type: feedback', 'type: project')
    .replace('title: Working Preferences', 'title: Workspace State')
    .replace('# Working Preferences', '# Workspace State');
  expect(await tool.execute({ path: paths.workspaceFile, content: workspaceProfile })).toMatchObject({ status: 'completed' });
  expect(readFileSync(paths.indexFile, 'utf8')).not.toContain('Workspace State');
});

it('requires a summary with facts, a stamped date, and a correct profile type', () => {
  expect(validateMemoryDocument(note)).toEqual([]);
  expect(validateMemoryDocument(note, 'user')).toContain('This profile requires type: user.');
  expect(validateMemoryDocument(note.replace(/^updated:.*$/m, ''))).toEqual(expect.arrayContaining([expect.stringContaining('updated')]));
  expect(validateMemoryDocument(note.replace('2026-10-11', '11.10.2026'))).toEqual(
    expect.arrayContaining([expect.stringContaining('updated')]),
  );
  const headingsOnly = `---
type: feedback
title: Empty Ceremony
description: Headings with no facts.
updated: 2026-10-11
---
# Empty Ceremony
## Subject Area
### Memory Item
`;
  expect(validateMemoryDocument(headingsOnly)).toEqual(expect.arrayContaining([expect.stringContaining('not just headings')]));
  expect(validateMemoryDocument(note.replace('# Working Preferences', '# Different Title'))).toEqual(
    expect.arrayContaining([expect.stringContaining('H1 must match')]),
  );
  expect(
    validateMemoryDocument(
      note.replace(
        '- Remove temporary artifacts after the task is complete. (Explicit user correction.)',
        '- Remove temporary artifacts after the task is complete. (Explicit user correction.)\n\n```sh\n# a shell comment, not a second document\n```',
      ),
    ),
  ).toEqual([]);
});

it('retains the description, the stamped date, and exact original source lines for each indexed memory chunk', () => {
  const document = parseMemoryDocument(note, 'working-preferences.md', 'user');
  expect(document.updated).toBe('2026-10-11');
  const chunk = document.chunks.find((chunk) => chunk.content.includes('Remove temporary artifacts'))!;
  expect(chunk.heading).toBe('Working Preferences');
  expect(chunk.embeddingText).toContain(document.description);
  expect(
    note
      .split('\n')
      .slice(chunk.startLine - 1, chunk.endLine)
      .join('\n')
      .trim(),
  ).toBe(chunk.content);
  expect(document.chunks.some((chunk) => chunk.content === '# Working Preferences')).toBe(false);
});

it('keeps the global entrypoint to concise shared-user links and supplies current paths and the same writing contract to the model', () => {
  const paths = getMemoryPaths(workspace);
  const index = '# Memory Index\n## User\n- [User profile](user/profile.md) — brief user signals (2026-10-11)\n';
  put(paths.indexFile, index);
  expect(validateMemoryIndex(index)).toEqual([]);
  expect(validateMemoryIndex(index + '- [Dateless](topics/dateless.md) — no date here\n')).not.toEqual([]);
  expect(
    validateMemoryIndex(index + '- [Other workspace](workspaces/000000000000000000000000/profile.md) — unrelated facts (2026-10-11)\n'),
  ).not.toEqual([]);
  const system = getAgentContext([], false, workspace).system;
  expect(system).toContain(paths.userFile);
  expect(system).toContain(paths.preferencesFile);
  expect(system).toContain(paths.workspaceFile);
  expect(system).toContain('never a substitute for content');
  expect(system).toContain('Append only independent facts');
  expect(system).toContain('Persistent Continuity');
  expect(system).toContain('expected future utility');
  expect(system).not.toContain('Nobody will say "remember this"');
  expect(system).toContain('three months');
  expect(system).not.toContain('Loaded user context');
  expect(system).not.toContain('every H3 entry needs a non-empty #### Summary');
  expect(system).not.toContain('user/notes');
  expect(readdirSync(paths.root)).not.toContain('user.md');
});

it('inlines the user preferences and profile into the system prompt when they exist', () => {
  const paths = getMemoryPaths(workspace);
  put(paths.preferencesFile, '---\ntitle: Prefs\ndescription: D\nupdated: 2026-10-13\ntype: user\n---\n# Prefs\n\nReply briefly.\n');
  put(paths.userFile, '---\ntitle: Who\ndescription: D\nupdated: 2026-10-13\ntype: user\n---\n# Who\n\nSolo developer.\n');
  const system = getAgentContext([], false, workspace).system;
  expect(system).toContain('Loaded user context');
  expect(system).toContain('Reply briefly.');
  expect(system).toContain('Solo developer.');
});

it('refuses a linked component inside the memory tree so one scope cannot masquerade as another', () => {
  const paths = getMemoryPaths(workspace);
  const external = join(root, 'external-topics');
  mkdirSync(external, { recursive: true });
  mkdirSync(paths.root, { recursive: true });
  try {
    symlinkSync(external, join(paths.root, 'topics'), process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EPERM') return;
    throw error;
  }
  const disguised = join(paths.topicsDirectory, 'foreign.md');
  expect(getMemoryDocumentPath(disguised, workspace)).toBeNull();
  expect(isMemoryDocumentPath(disguised, workspace)).toBe(false);
});

it('rejects a linked index file and keeps accepting the real one', () => {
  const paths = getMemoryPaths(workspace);
  expect(isMemoryIndexPath(paths.indexFile, workspace)).toBe(true);
  mkdirSync(paths.root, { recursive: true });
  const external = join(root, 'outside-index.md');
  writeFileSync(external, '# Outside index\n');
  try {
    symlinkSync(external, paths.indexFile, 'file');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EPERM' || code === 'EACCES' || code === 'ENOSYS' || code === 'UNKNOWN') return;
    throw error;
  }
  expect(isMemoryIndexPath(paths.indexFile, workspace)).toBe(false);
});

it('keeps both entries when two user-scope writes race on the same index', async () => {
  const paths = getMemoryPaths(workspace);
  const first = join(paths.topicsDirectory, 'first-note.md');
  const second = join(paths.topicsDirectory, 'second-note.md');
  put(first, note.replace('Working Preferences', 'First Note').replace('title: Working Preferences', 'title: First Note'));
  put(second, note.replace('Working Preferences', 'Second Note').replace('title: Working Preferences', 'title: Second Note'));
  const [left, right] = await Promise.all([ensureMemoryIndexEntry(first, workspace), ensureMemoryIndexEntry(second, workspace)]);
  expect(left).toMatchObject({ memoryIndexEntry: 'added' });
  expect(right).toMatchObject({ memoryIndexEntry: 'added' });
  const index = readFileSync(paths.indexFile, 'utf8');
  expect(index).toContain('(topics/first-note.md)');
  expect(index).toContain('(topics/second-note.md)');
});
