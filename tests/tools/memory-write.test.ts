import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMemoryWriteTool } from '../../src/tools/memory-write.js';

let workspace: string;
let memoryRoot: string;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'openbutler-memory-write-'));
  memoryRoot = join(workspace, 'MEMORY');
  process.env.OPENBUTLER_DATA_DIR = workspace;
});

afterEach(async () => {
  delete process.env.OPENBUTLER_DATA_DIR;
  await rm(workspace, { recursive: true, force: true });
});

const note = (slug: string) => join(memoryRoot, 'topics', `${slug}.md`);
const index = () => join(memoryRoot, 'MEMORY.md');

async function run(input: Record<string, unknown>): Promise<Record<string, unknown>> {
  const tool = createMemoryWriteTool(workspace);
  return (await tool.execute!(input, undefined, undefined)) as Record<string, unknown>;
}

describe('memory_write', () => {
  it('creates a note with frontmatter, heading, summary and bullets', async () => {
    const result = await run({
      action: 'create',
      scope: 'topic',
      slug: 'commit-granularity',
      title: 'Commit granularity preference',
      description: 'Batch the work and make one commit at the end',
      summary: 'The owner prefers one commit at the end of a piece of work.',
      bullets: ['Stated 2026-10-14 after eleven local commits.'],
    });
    expect(result.status).toBe('completed');
    const text = await readFile(note('commit-granularity'), 'utf8');
    expect(text).toContain('title: Commit granularity preference');
    expect(text).toContain('# Commit granularity preference');
    expect(text).toContain('- Stated 2026-10-14 after eleven local commits.');
    expect(text).toMatch(/^updated: \d{4}-\d{2}-\d{2}$/m);
  });

  it('adds the index line so the note is discoverable', async () => {
    await run({
      action: 'create',
      scope: 'topic',
      slug: 'commit-granularity',
      title: 'Commit granularity preference',
      description: 'Batch the work and make one commit at the end',
      summary: 'The owner prefers one commit at the end.',
      bullets: ['Stated 2026-10-14.'],
    });
    const text = await readFile(index(), 'utf8');
    expect(text).toContain('[Commit granularity preference](topics/commit-granularity.md)');
  });

  it('refuses to overwrite an existing note', async () => {
    const input = {
      action: 'create',
      scope: 'topic',
      slug: 'existing',
      title: 'Existing note',
      description: 'Already here',
      summary: 'Something.',
      bullets: ['A fact.'],
    };
    await run(input);
    const second = await run(input);
    expect(second.status).toBe('exists');
    expect(await readFile(note('existing'), 'utf8')).toContain('A fact.');
  });

  it('appends only bullets that are not already present', async () => {
    await run({
      action: 'create',
      scope: 'topic',
      slug: 'append-me',
      title: 'Append me',
      description: 'Append behaviour',
      summary: 'A note.',
      bullets: ['First fact.'],
    });
    const added = await run({ action: 'append', scope: 'topic', slug: 'append-me', bullets: ['Second fact.'] });
    expect(added.status).toBe('completed');
    const duplicate = await run({ action: 'append', scope: 'topic', slug: 'append-me', bullets: ['Second fact.'] });
    expect(duplicate.status).toBe('unchanged');
    const text = await readFile(note('append-me'), 'utf8');
    expect(text.match(/Second fact\./g)).toHaveLength(1);
  });

  it('replaces one exact piece of text and refuses an ambiguous one', async () => {
    await run({
      action: 'create',
      scope: 'topic',
      slug: 'replace-me',
      title: 'Replace me',
      description: 'Replace behaviour',
      summary: 'A note.',
      bullets: ['old wording', 'old wording again'],
    });
    const ambiguous = await run({ action: 'replace', scope: 'topic', slug: 'replace-me', old: 'old wording', new: 'new' });
    expect(ambiguous.status).toBe('ambiguous');
    const replaced = await run({
      action: 'replace',
      scope: 'topic',
      slug: 'replace-me',
      old: 'old wording again',
      new: 'fresh wording',
    });
    expect(replaced.status).toBe('completed');
    expect(await readFile(note('replace-me'), 'utf8')).toContain('fresh wording');
  });

  it('updates the title, the heading and the description together', async () => {
    await run({
      action: 'create',
      scope: 'area',
      slug: 'some-area',
      title: 'Old title',
      description: 'Old description',
      summary: 'A note.',
      bullets: ['A fact.'],
    });
    const result = await run({
      action: 'describe',
      scope: 'area',
      slug: 'some-area',
      title: 'New title',
      description: 'New description',
    });
    expect(result.status).toBe('completed');
    const text = await readFile(join(memoryRoot, 'areas', 'some-area.md'), 'utf8');
    expect(text).toContain('title: New title');
    expect(text).toContain('# New title');
    expect(text).toContain('description: New description');
    expect(await readFile(index(), 'utf8')).toContain('[New title]');
  });

  it('keeps the workspace profile out of the index', async () => {
    const result = await run({
      action: 'create',
      scope: 'workspace',
      title: 'Workspace profile',
      description: 'Local state',
      summary: 'Where the work stands.',
      bullets: ['A fact.'],
    });
    expect(result.status).toBe('completed');
    expect(result.index).toBe('not-indexed');
    expect(existsSync(join(memoryRoot, 'MEMORY.md'))).toBe(false);
  });

  it('rejects a colon in frontmatter values and a bad slug', async () => {
    const colon = await run({
      action: 'create',
      scope: 'topic',
      slug: 'bad-value',
      title: 'Title: with colon',
      description: 'Description',
      summary: 'Summary.',
      bullets: ['A fact.'],
    });
    expect(colon.status).toBe('invalid');
    const slug = await run({
      action: 'create',
      scope: 'topic',
      slug: '../escape',
      title: 'Title',
      description: 'Description',
      summary: 'Summary.',
      bullets: ['A fact.'],
    });
    expect(slug.status).toBe('invalid');
  });

  it('reports a missing note instead of creating one by accident', async () => {
    const result = await run({ action: 'append', scope: 'topic', slug: 'never-created', bullets: ['A fact.'] });
    expect(result.status).toBe('missing');
    expect(existsSync(note('never-created'))).toBe(false);
  });
});

// A note written by the tool must be readable UTF-8 with no doubled encoding. The
// sample text is escaped so the repository language guard stays green.
describe('memory_write encoding', () => {
  it('writes non-ASCII characters intact', async () => {
    const summary = 'T\u00fcrk\u00e7e karakterler korunmal\u0131.';
    const bullet = 'Masa\u00fcst\u00fc ve \u0130ndirilenler.';
    await mkdir(memoryRoot, { recursive: true });
    await writeFile(index(), '# Memory\n', 'utf8');
    await run({
      action: 'create',
      scope: 'topic',
      slug: 'non-ascii',
      title: 'Non-ASCII characters',
      description: 'Encoding check',
      summary,
      bullets: [bullet],
    });
    const text = await readFile(note('non-ascii'), 'utf8');
    expect(text).toContain(summary);
    expect(text).toContain(bullet);
    expect(text).not.toContain('\u00c3');
  });
});
