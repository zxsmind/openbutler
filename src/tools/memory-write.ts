import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getMemoryPaths } from '../memory-paths.js';
import { MEMORY_INDEX_MAX_BYTES, MEMORY_INDEX_MAX_LINES } from '../memory-document.js';
import { validateTextWrite, writeTextAtomically } from '../file-write-core.js';
import { classifyTrustedPath, trustedRootsFor } from '../workspace-scope.js';
import type { MemoryIndex } from '../memory-index.js';
import type { ToolDefinition, ToolEffect } from './registry.js';

const memoryWriteEffect: ToolEffect = {
  change: 'modify',
  data: 'sensitive',
  network: 'none',
  reversible: 'compensating',
  outbound: 'none',
};

export type MemoryWriteScope = 'topic' | 'area' | 'preferences' | 'profile' | 'workspace';

const SCOPES: readonly MemoryWriteScope[] = ['topic', 'area', 'preferences', 'profile', 'workspace'];
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const INDEX_LINK = /^- \[[^\]]*\]\(([^)]+)\)/;

function today(): string {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
}

/** Frontmatter values stay plain text without colons, so the YAML never needs quoting. */
function plainValue(value: unknown, field: string, max: number): { ok: true; value: string } | { ok: false; error: string } {
  if (typeof value !== 'string' || !value.trim()) return { ok: false, error: `${field} must be a non-empty string.` };
  const trimmed = value.trim();
  if (trimmed.length > max) return { ok: false, error: `${field} must be ${max} characters or fewer.` };
  if (trimmed.includes(':') || trimmed.includes('\n')) {
    return { ok: false, error: `${field} must be one line without a colon, so the frontmatter stays valid YAML.` };
  }
  return { ok: true, value: trimmed };
}

function normalizeBullets(value: unknown): { ok: true; bullets: string[] } | { ok: false; error: string } {
  if (!Array.isArray(value) || value.length === 0) return { ok: false, error: 'bullets must be a non-empty array.' };
  const bullets: string[] = [];
  for (const [index, raw] of value.entries()) {
    if (typeof raw !== 'string' || !raw.trim()) return { ok: false, error: `bullets[${index}] must be a non-empty string.` };
    const text = raw.trim().replace(/^-\s*/, '');
    if (text.includes('\n')) return { ok: false, error: `bullets[${index}] must be a single line.` };
    bullets.push(`- ${text}`);
  }
  return { ok: true, bullets };
}

function renderNote(options: {
  title: string;
  description: string;
  summary: string;
  bullets: string[];
  date: string;
  type: 'user' | 'project';
}): string {
  return [
    '---',
    `title: ${options.title}`,
    `description: ${options.description}`,
    `updated: ${options.date}`,
    `type: ${options.type}`,
    '---',
    `# ${options.title}`,
    '',
    options.summary.trim(),
    '',
    ...options.bullets,
    '',
  ].join('\n');
}

/**
 * Writes durable memory without hand-building the note.
 *
 * Writing memory used to mean composing the frontmatter, the heading, the
 * summary and the index line by hand across several file calls, which is why it
 * only happened when the owner asked. This tool owns that shape: one call
 * creates or updates a note, stamps the date, and keeps MEMORY.md in step.
 */
export function createMemoryWriteTool(workspaceRoot = process.cwd(), memoryIndex?: MemoryIndex): ToolDefinition {
  const paths = getMemoryPaths(workspaceRoot);

  const resolveTarget = (
    scope: MemoryWriteScope,
    slug: unknown,
  ): { ok: true; path: string; indexed: boolean } | { ok: false; error: string } => {
    if (scope === 'preferences') return { ok: true, path: paths.preferencesFile, indexed: true };
    if (scope === 'profile') return { ok: true, path: paths.userFile, indexed: true };
    if (scope === 'workspace') return { ok: true, path: paths.workspaceFile, indexed: false };
    if (typeof slug !== 'string' || !SLUG.test(slug)) {
      return { ok: false, error: `slug must be kebab-case English, for example "commit-granularity".` };
    }
    const directory = scope === 'topic' ? paths.topicsDirectory : paths.areasDirectory;
    return { ok: true, path: join(directory, `${slug}.md`), indexed: true };
  };

  return {
    providerId: 'host',
    name: 'memory_write',
    description:
      'Create or update one durable memory note and keep MEMORY.md in step. Use it whenever a task established something a future session would otherwise have to rediscover: a dated decision, a preference the owner stated, a path that took debugging, or the state of a project. Actions: `create` writes a new note (refused if it exists); `append` adds bullets that are not already there; `replace` changes one exact piece of text (it must match exactly once); `describe` updates the title and description. Scope decides the folder: `topic` and `area` are the shared user scope (slug required), `preferences` and `profile` are the reserved user files, and `workspace` is this workspace profile, which is never listed in the index. The tool stamps `updated` with today and adds or refreshes the single index line, so never edit MEMORY.md by hand. The note format is frontmatter, one H1 that matches the title, one summary paragraph, then one durable fact per bullet.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['create', 'append', 'replace', 'describe'], description: 'What to do with the note.' },
        scope: {
          type: 'string',
          enum: ['topic', 'area', 'preferences', 'profile', 'workspace'],
          description: 'Which memory file this is. It decides the folder; frontmatter cannot change it.',
        },
        slug: { type: 'string', description: 'Kebab-case file name for topic and area scopes.' },
        title: { type: 'string', description: 'create: document title, at most 160 characters, no colon.' },
        description: { type: 'string', description: 'create/describe: what the note covers, at most 500 characters, no colon.' },
        summary: { type: 'string', description: 'create: one short paragraph saying what the note records and why it matters.' },
        bullets: {
          type: 'array',
          items: { type: 'string' },
          description: 'create/append: one durable fact per bullet, with its evidence and date.',
        },
        old: { type: 'string', description: 'replace: exact existing text to change; it must occur exactly once.' },
        new: { type: 'string', description: 'replace: replacement text; an empty string deletes it.' },
      },
      required: ['action', 'scope'],
      additionalProperties: false,
    },
    effect: memoryWriteEffect,
    resolveTarget: (input) => {
      const scope = input.scope as MemoryWriteScope;
      const target = resolveTarget(scope, input.slug);
      return target.ok ? target.path : null;
    },
    workspaceScope: (_input, target) => {
      // Memory lives outside the workspace by design; it is a trusted host path.
      if (!target) return 'unknown';
      try {
        return classifyTrustedPath(target, trustedRootsFor(workspaceRoot));
      } catch {
        return 'unknown';
      }
    },
    hostPreAuthorized: () => true,
    assess: (_input, target) => ({
      ...memoryWriteEffect,
      change: target && existsSync(target) ? 'modify' : 'create',
      data: 'sensitive',
    }),
    execute: async (input) => {
      const action = input.action;
      if (action !== 'create' && action !== 'append' && action !== 'replace' && action !== 'describe') {
        return { status: 'invalid', error: 'action must be create, append, replace, or describe.' };
      }
      const scope = input.scope as MemoryWriteScope;
      if (!SCOPES.includes(scope)) {
        return { status: 'invalid', error: 'scope must be topic, area, preferences, profile, or workspace.' };
      }
      const target = resolveTarget(scope, input.slug);
      if (!target.ok) return { status: 'invalid', error: target.error };
      const path = target.path;
      const date = today();
      const exists = existsSync(path);
      const previous = exists ? await readFile(path, 'utf8') : '';

      let next: string;
      if (action === 'create') {
        if (exists) {
          return {
            status: 'exists',
            path,
            error: 'That note already exists. Use append to add a fact or replace to change one, so nothing is lost.',
          };
        }
        const title = plainValue(input.title, 'title', 160);
        const description = plainValue(input.description, 'description', 500);
        if (!title.ok) return { status: 'invalid', error: title.error };
        if (!description.ok) return { status: 'invalid', error: description.error };
        const summary = typeof input.summary === 'string' ? input.summary.trim() : '';
        if (!summary) return { status: 'invalid', error: 'summary must be a non-empty paragraph.' };
        const bullets = normalizeBullets(input.bullets);
        if (!bullets.ok) return { status: 'invalid', error: bullets.error };
        next = renderNote({
          title: title.value,
          description: description.value,
          summary,
          bullets: bullets.bullets,
          date,
          // The workspace profile carries project state, and the validator enforces it.
          type: scope === 'workspace' ? 'project' : 'user',
        });
      } else {
        if (!exists) return { status: 'missing', path, error: 'That note does not exist yet; use create first.' };
        if (action === 'append') {
          const bullets = normalizeBullets(input.bullets);
          if (!bullets.ok) return { status: 'invalid', error: bullets.error };
          const added = bullets.bullets.filter((bullet) => !previous.includes(bullet));
          if (added.length === 0) return { status: 'unchanged', path, error: 'Every bullet is already in the note.' };
          next = `${previous.trimEnd()}\n${added.join('\n')}\n`;
        } else if (action === 'replace') {
          const old = typeof input.old === 'string' ? input.old : '';
          const replacement = typeof input.new === 'string' ? input.new : null;
          if (!old) return { status: 'invalid', error: 'old must be a non-empty string.' };
          if (replacement === null) return { status: 'invalid', error: 'new must be a string; use "" to delete.' };
          const first = previous.indexOf(old);
          if (first === -1) return { status: 'no_match', path, error: 'The exact `old` text is not in the note.' };
          if (previous.indexOf(old, first + old.length) !== -1) {
            return { status: 'ambiguous', path, error: '`old` appears more than once; include more surrounding text.' };
          }
          next = previous.slice(0, first) + replacement + previous.slice(first + old.length);
        } else {
          const title = plainValue(input.title, 'title', 160);
          const description = plainValue(input.description, 'description', 500);
          if (!title.ok) return { status: 'invalid', error: title.error };
          if (!description.ok) return { status: 'invalid', error: description.error };
          next = previous
            .replace(/^title: .*$/m, `title: ${title.value}`)
            .replace(/^description: .*$/m, `description: ${description.value}`)
            .replace(/^# .*$/m, `# ${title.value}`);
        }
        next = next.replace(/^updated: .*$/m, `updated: ${date}`);
      }

      const validation = validateTextWrite(next, path, workspaceRoot);
      if (!validation.ok) return validation.failure;
      await writeTextAtomically(path, next);

      const outcome: Record<string, unknown> = {
        status: 'completed',
        action,
        scope,
        path,
        updated: date,
        sha256: validation.sha256,
        lineCount: next.split(/\r?\n/).length,
      };

      if (target.indexed) {
        const index = await readFile(paths.indexFile, 'utf8').catch(() => '');
        const titleMatch = /^title: (.*)$/m.exec(next);
        const descriptionMatch = /^description: (.*)$/m.exec(next);
        const link = `${scope === 'preferences' ? 'user/preferences.md' : scope === 'profile' ? 'user/profile.md' : `${scope === 'topic' ? 'topics' : 'areas'}/${String(input.slug)}.md`}`;
        const line = `- [${titleMatch?.[1] ?? link}](${link}) — ${descriptionMatch?.[1] ?? ''} (${date})`;
        const lines = index ? index.trimEnd().split('\n') : ['# Memory', ''];
        const existing = lines.findIndex((entry) => {
          const match = INDEX_LINK.exec(entry.trim());
          return match?.[1] === link;
        });
        if (existing >= 0) lines[existing] = line;
        else {
          const lastEntry = lines.map((entry) => entry.startsWith('- ')).lastIndexOf(true);
          lines.splice(lastEntry >= 0 ? lastEntry + 1 : lines.length, 0, line);
        }
        const rendered = `${lines.join('\n')}\n`;
        if (lines.length > MEMORY_INDEX_MAX_LINES || Buffer.byteLength(rendered, 'utf8') > MEMORY_INDEX_MAX_BYTES) {
          return {
            status: 'completed',
            ...outcome,
            index: 'skipped',
            error: `MEMORY.md would exceed its ${MEMORY_INDEX_MAX_LINES}-line or ${Math.floor(MEMORY_INDEX_MAX_BYTES / 1024)} KB cap; prune it before adding entries.`,
          };
        }
        await writeTextAtomically(paths.indexFile, rendered);
        outcome.index = existing >= 0 ? 'updated' : 'added';
      } else {
        outcome.index = 'not-indexed';
      }

      if (memoryIndex) {
        try {
          await memoryIndex.reindexPath(path);
        } catch {
          /* the index rebuilds on its own schedule */
        }
      }
      return outcome;
    },
  };
}
