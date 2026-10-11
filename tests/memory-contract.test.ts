import { mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { getMemoryDocumentPath, getMemoryPaths, isMemoryDocumentPath, isMemoryIndexPath } from '../src/memory-paths.js';
import { migrateMemoryLayout } from '../src/memory-layout.js';
import { parseMemoryDocument, validateMemoryDocument, validateMemoryIndex } from '../src/memory-document.js';
import { createWriteTool } from '../src/tools/file-write.js';
import { getAgentContext } from '../src/agent.js';

let root: string;
let workspace: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ranite-memory-contract-test-'));
  workspace = join(root, 'workspace');
  mkdirSync(workspace);
  vi.stubEnv('RANITE_DATA_DIR', join(root, 'data'));
});
afterEach(async () => {
  vi.unstubAllEnvs();
  if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith('ranite-memory-contract-test-'))
    throw new Error('Unsafe memory fixture cleanup path.');
  await rm(root, { recursive: true, force: true });
});

const note = `---
type: feedback
title: Working Preferences
description: User preferences about temporary working files.
---
# Working Preferences
## Workspace Files
### Temporary Artifact Location
#### Summary
Use the operating system temporary directory for research scripts.
#### Details
Remove temporary artifacts after the task is complete.
#### Evidence
Explicit user correction.
`;
function put(path: string, content: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

it('puts profiles beside their scoped notes and keeps other workspaces outside automatic access', () => {
  const paths = getMemoryPaths(workspace);
  expect(paths.userFile).toBe(join(paths.root, 'user', 'profile.md'));
  expect(paths.workspaceFile).toBe(join(paths.root, 'workspaces', paths.workspaceKey, 'profile.md'));
  expect(paths.userTopicsDirectory).toBe(join(paths.root, 'user', 'notes'));
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
  expect(migrated.moved).toHaveLength(4);
  expect(readFileSync(paths.userFile, 'utf8')).toBe('Exact old user preference.');
  expect(readFileSync(paths.workspaceFile, 'utf8')).toBe('Exact workspace facts.');
  expect(readFileSync(join(paths.userTopicsDirectory, 'feedback', 'working-files.md'), 'utf8')).toBe(note);
  expect(readFileSync(join(paths.workspaceTopicsDirectory, 'issue.md'), 'utf8')).toBe('Exact prior issue.');
  expect(readFileSync(paths.indexFile, 'utf8')).toContain('(user/profile.md)');
  expect(readFileSync(paths.indexFile, 'utf8')).toContain('(user/notes/feedback/working-files.md)');
  expect(migrateMemoryLayout(workspace).moved).toEqual([]);
});

it('rewrites moved memory links while leaving inline and fenced code examples untouched', () => {
  const paths = getMemoryPaths(workspace);
  const oldNote = `# Legacy note\n\n[Profile](../../user.md) and \`[example](../../user.md)\`.\n\n~~~md\n[example](../../user.md)\n~~~\n`;
  put(join(paths.root, 'user.md'), '# Legacy user profile');
  put(join(paths.root, 'user', 'feedback', 'links.md'), oldNote);
  put(paths.indexFile, '# Memory Index\n- [Profile](user.md) — shared user facts\n');
  migrateMemoryLayout(workspace);
  const migrated = readFileSync(join(paths.userTopicsDirectory, 'feedback', 'links.md'), 'utf8');
  expect(migrated).toContain('[Profile](../../profile.md)');
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
  mkdirSync(paths.userTopicsDirectory, { recursive: true });
  const external = join(root, 'external');
  mkdirSync(external);
  symlinkSync(external, join(paths.userTopicsDirectory, 'external'), process.platform === 'win32' ? 'junction' : 'dir');
  expect(isMemoryDocumentPath(join(paths.userTopicsDirectory, 'external', 'note.md'), workspace)).toBe(false);
});

it('validates new note structure before replacing the canonical file, while ordinary workspace files remain generic', async () => {
  const paths = getMemoryPaths(workspace);
  const path = join(paths.userTopicsDirectory, 'working-preferences.md');
  put(path, note);
  const tool = createWriteTool(workspace);
  expect(await tool.execute({ path, content: '# A flat replacement\nNo metadata.' })).toMatchObject({ status: 'invalid_memory_format' });
  expect(readFileSync(path, 'utf8')).toBe(note);
  expect(await tool.execute({ path: join(paths.root, 'user.md'), content: note })).toMatchObject({ status: 'invalid_memory_path' });
  expect(await tool.execute({ path: join(paths.userTopicsDirectory, 'Poor_Name.md'), content: note })).toMatchObject({
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
  const broken = '# Memory Index\n- [Preferences](user/notes/preferences.md) — communication preferences\n';
  expect(await tool.execute({ path: paths.indexFile, content: broken })).toMatchObject({ status: 'invalid_memory_index' });
  put(join(paths.userTopicsDirectory, 'preferences.md'), note);
  expect(await tool.execute({ path: paths.indexFile, content: broken })).toMatchObject({ status: 'completed' });
});

it('links every user-scope write from MEMORY.md exactly once and keeps workspace notes out of it', async () => {
  const paths = getMemoryPaths(workspace);
  const tool = createWriteTool(workspace);
  const notePath = join(paths.userTopicsDirectory, 'working-preferences.md');
  expect(await tool.execute({ path: notePath, content: note })).toMatchObject({ status: 'completed', memoryIndexEntry: 'added' });
  const index = readFileSync(paths.indexFile, 'utf8');
  expect(index).toContain('- [Working Preferences](user/notes/working-preferences.md) — User preferences about temporary working files.');
  expect(
    await tool.execute({ path: notePath, content: note.replace('Explicit user correction.', 'Recorded user correction.') }),
  ).toMatchObject({
    status: 'completed',
  });
  expect(await tool.execute({ path: notePath, content: note })).not.toMatchObject({ memoryIndexEntry: 'added' });
  expect(readFileSync(paths.indexFile, 'utf8').match(/user\/notes\/working-preferences\.md/g)).toHaveLength(1);
  const workspaceNote = join(paths.workspaceTopicsDirectory, 'workspace-topic.md');
  expect(await tool.execute({ path: workspaceNote, content: note })).toMatchObject({ status: 'completed' });
  expect(readFileSync(paths.indexFile, 'utf8')).not.toContain('workspace-topic.md');
});

it('requires a substantive summary and correct profile type, without treating fenced code as headings', () => {
  expect(validateMemoryDocument(note)).toEqual([]);
  expect(validateMemoryDocument(note, 'user')).toContain('This profile requires type: user.');
  expect(validateMemoryDocument(note.replace('Use the operating system temporary directory for research scripts.', ''))).toEqual(
    expect.arrayContaining([expect.stringContaining('non-empty')]),
  );
  expect(validateMemoryDocument(note.replace('Explicit user correction.', '```sh\n# a shell comment, not a second document\n```'))).toEqual(
    [],
  );
});

it('retains the complete parent hierarchy, description, and exact original source lines for each indexed memory chunk', () => {
  const document = parseMemoryDocument(note, 'working-preferences.md', 'user');
  const chunk = document.chunks.find((chunk) => chunk.content.includes('Remove temporary artifacts'))!;
  expect(chunk.heading).toBe('Working Preferences > Workspace Files > Temporary Artifact Location > Details');
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
  const index = '# Memory Index\n## User\n- [User profile](user/profile.md) — brief user signals\n';
  put(paths.indexFile, index);
  expect(validateMemoryIndex(index)).toEqual([]);
  expect(
    validateMemoryIndex(index + '- [Other workspace](workspaces/000000000000000000000000/profile.md) — unrelated facts\n'),
  ).not.toEqual([]);
  const system = getAgentContext([], false, workspace).system;
  expect(system).toContain(paths.userFile);
  expect(system).toContain(paths.workspaceFile);
  expect(system).toContain('every H3 entry needs a non-empty #### Summary');
  expect(system).toContain('profiles marked not initialized');
  expect(system).not.toContain('Turkish responses; no emojis');
  expect(readdirSync(paths.root)).not.toContain('user.md');
});

it('refuses a linked component inside the memory tree so one scope cannot masquerade as another', () => {
  const paths = getMemoryPaths(workspace);
  const other = join(root, 'other-workspace');
  mkdirSync(other);
  const otherPaths = getMemoryPaths(other);
  put(join(otherPaths.workspaceTopicsDirectory, 'foreign.md'), note);
  mkdirSync(join(paths.root, 'user'), { recursive: true });
  try {
    symlinkSync(otherPaths.workspaceTopicsDirectory, join(paths.root, 'user', 'notes'), process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EPERM') return;
    throw error;
  }
  const disguised = join(paths.root, 'user', 'notes', 'foreign.md');
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
