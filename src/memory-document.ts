import { JSON_SCHEMA, load } from 'js-yaml';
import { basename } from 'node:path';

export const MEMORY_DOCUMENT_REVISION = 'markdown-v3';
export const MEMORY_INDEX_MAX_LINES = 200;
export const MEMORY_INDEX_MAX_BYTES = 25 * 1024;
export type MemoryType = 'user' | 'feedback' | 'project' | 'reference';
export type MemoryScope = 'user' | `workspace:${string}`;
const TYPES: readonly MemoryType[] = ['user', 'feedback', 'project', 'reference'];
const CHUNK_CHAR_LIMIT = 1_400;

export interface MemoryChunk {
  ordinal: number;
  startLine: number;
  endLine: number;
  heading: string;
  content: string;
  embeddingText: string;
}
export interface MemoryDocument {
  type: MemoryType;
  title: string;
  description: string;
  updated: string;
  chunks: MemoryChunk[];
}

export const MEMORY_DOCUMENT_GUIDANCE = `Memory is Markdown under the persistent memory root. The user scope holds how to respond (user/preferences.md), who the user is (user/profile.md), durable topics (topics/*.md), and project areas (areas/*.md). The active workspace holds only its own profile (workspaces/<workspace-key>/profile.md). Folder placement defines scope; frontmatter cannot change it. MEMORY.md is the single cross-workspace index over the user scope only, capped at ${MEMORY_INDEX_MAX_LINES} lines and ${Math.floor(MEMORY_INDEX_MAX_BYTES / 1024)} KB; the workspace profile is discovered through the active workspace path and is never linked from this index.

Every memory note is flat:

    ---
    title: <document title, at most 160 characters>
    description: <what this document covers, at most 500 characters>
    updated: <YYYY-MM-DD, stamped by the write path>
    type: user
    ---
    # <same as title>

    <One short summary paragraph: what this note says and why it matters.>

    - <One durable fact per bullet: facts, decisions, rules, dated numbers.>
    - <Uncertain or unresolved items are marked as such, never stated as fact.>

- The single H1 matches the title exactly. Filenames are descriptive English kebab-case; preferences.md and profile.md are reserved names. Frontmatter values are plain text without colons, so they stay valid YAML.
- Write the summary so it can be acted on without reading the bullets. Evidence travels with the fact (session id, date, brief command), never in a separate section.
- The profile holds what will still be true in three months: name, occupation, location, main projects. Tastes, states, and incidents belong in topics; ongoing work belongs in areas. If it expires in weeks, it is not profile material.
- Sub-headings are optional and never a substitute for content: a note with headings but no text has nothing to retrieve.
- Memory is written entirely in English: titles, descriptions, signals, summaries, and bullets. The local embedding model is English-based; other languages retrieve poorly. Translate user quotations into English; exact identifiers (paths, folder names, codes, UI labels) stay verbatim.
- Save only durable information that cannot be derived from the current repository or reread from a primary source. No progress logs, no run transcripts, no raw tool output; what happened lives in session transcripts.
- Durable information includes numbers, identifiers, and decisions with their dates, and tricks that took debugging to find, with proof. Do not save run progress, per-item statuses, fixed-bug archaeology, or anything the repository already records (commit history, README, configs). Durable: "Staging deploys run weekdays at 09:00 UTC from the main branch (confirmed 2026-10-01, deploy log)." Transient: "Deploy running, 3 steps left, will update when done."
- One fact has one canonical home. Standing rules go in preferences or a single topic; project areas go in areas/ so every workspace sees them; directory-local workings go in the workspace profile. Never copy a fact into two notes; point at it.
- Maintain, do not append: edit the bullet a changed fact lives in. Delete completed status. Notes carry an updated date; before relying on an old note, reverify it, refresh the date when confirmed, fix or delete when wrong.
- Never store credentials, secrets, identity or payment numbers, health information, political views, raw file contents, image data, or conversation transcripts. The only exception is the user explicitly asking to remember something sensitive, recorded plainly as their request.
- A native write stamps updated with today's date and adds the MEMORY.md entry for a new user-scope document automatically; do not duplicate it. MEMORY.md entries are one line each: a title link, a short signal, and the date.`;

function frontmatter(lines: string[]): { metadata: Record<string, unknown>; bodyStart: number; error: string | null } {
  if (lines[0]?.trim() !== '---') return { metadata: {}, bodyStart: 0, error: 'YAML frontmatter is required.' };
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
  if (end < 0) return { metadata: {}, bodyStart: 0, error: 'YAML frontmatter must end with ---.' };
  try {
    const value: unknown = load(lines.slice(1, end).join('\n'), { schema: JSON_SCHEMA });
    if (!value || typeof value !== 'object' || Array.isArray(value))
      return { metadata: {}, bodyStart: end + 1, error: 'Frontmatter must be a mapping.' };
    return { metadata: value as Record<string, unknown>, bodyStart: end + 1, error: null };
  } catch (error) {
    return { metadata: {}, bodyStart: end + 1, error: `Invalid frontmatter: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/** Markdown headings inside fenced examples are content, not document structure. */
function headingReader() {
  let fence: { char: string; length: number } | null = null;
  return (line: string): { level: number; title: string } | null => {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (marker) {
      if (!fence) fence = { char: marker[1]![0]!, length: marker[1]!.length };
      else if (marker[1]![0] === fence.char && marker[1]!.length >= fence.length && !marker[2]!.trim()) fence = null;
      return null;
    }
    if (fence) return null;
    const match = /^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    return match ? { level: match[1]!.length, title: match[2]!.trim() } : null;
  };
}

export function validateMemoryDocument(content: string, expectedProfileType?: 'user' | 'project'): string[] {
  const lines = content.split(/\r?\n/);
  const parsed = frontmatter(lines);
  if (parsed.error) return [parsed.error];
  const errors: string[] = [];
  const { type, title, description, updated } = parsed.metadata;
  if (typeof type !== 'string' || !TYPES.includes(type as MemoryType)) errors.push('type must be user, feedback, project, or reference.');
  if (expectedProfileType && type !== expectedProfileType) errors.push(`This profile requires type: ${expectedProfileType}.`);
  if (typeof title !== 'string' || !title.trim() || title.length > 160)
    errors.push('title must be a non-empty string of at most 160 characters.');
  if (typeof description !== 'string' || !description.trim() || description.length > 500)
    errors.push('description must be a non-empty string of at most 500 characters.');
  if (typeof updated !== 'string' || !isCalendarDate(updated))
    errors.push('updated must be a calendar date as YYYY-MM-DD; the write path stamps it, so keep the line and let it be refreshed.');
  const readHeading = headingReader();
  let documentTitles = 0;
  let hasContent = false;
  for (let index = parsed.bodyStart; index < lines.length; index++) {
    const line = lines[index]!;
    const heading = readHeading(line);
    if (!heading) {
      if (line.trim()) hasContent = true;
      continue;
    }
    if (heading.level === 1) {
      documentTitles++;
      if (heading.title !== title) errors.push('The H1 must match the frontmatter title.');
    }
  }
  if (documentTitles !== 1) errors.push('Use exactly one H1 document title.');
  if (!hasContent) errors.push('Write the summary and facts, not just headings: the body needs text outside headings.');
  return [...new Set(errors)];
}

export function validateMemoryNoteName(notePath: string): boolean {
  const parts = notePath.replace(/\\/g, '/').split('/');
  const filename = parts.pop() ?? '';
  return (
    parts.every((part) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(part)) &&
    /^[a-z0-9]+(?:-[a-z0-9]+)*\.md$/.test(filename) &&
    !['profile.md', 'index.md', 'memory.md'].includes(filename)
  );
}

export function validateMemoryIndex(content: string): string[] {
  const errors: string[] = [];
  let titles = 0;
  for (const [index, line] of content.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    if (/^#\s+/.test(line)) {
      titles++;
      continue;
    }
    if (/^#{2,6}\s+/.test(line)) continue;
    const entry = /^-\s+\[([^\]]+)\]\(([^)\s]+)\)\s*(?:—|-|:)\s+(.+?)\s*$/.exec(line);
    if (!entry) {
      errors.push(`Line ${index + 1}: use one Markdown link, a brief signal, and the updated date per index entry.`);
      continue;
    }
    const path = entry[2]!;
    if (!isIndexableUserPath(path)) {
      errors.push(
        `Line ${index + 1}: index links must target user/preferences.md, user/profile.md, topics/*.md, or areas/*.md. The workspace profile is discovered through the active workspace path.`,
      );
      continue;
    }
    const date = /\((\d{4}-\d{2}-\d{2})\)\s*$/.exec(entry[3]!);
    if (!date || !isCalendarDate(date[1]!)) errors.push(`Line ${index + 1}: end the signal with the note's updated date as (YYYY-MM-DD).`);
  }
  if (titles !== 1) errors.push('The memory index requires exactly one H1 title.');
  return errors;
}

function isIndexableUserPath(path: string): boolean {
  if (path === 'user/profile.md' || path === 'user/preferences.md') return true;
  if (path.startsWith('topics/')) return validateMemoryNoteName(path.slice('topics/'.length));
  return path.startsWith('areas/') && validateMemoryNoteName(path.slice('areas/'.length));
}

export function isCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]!);
  const month = Number(match[2]!);
  const day = Number(match[3]!);
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/** Reading remains compatible with legacy notes; new native writes use the validator above. */
export function parseMemoryDocument(content: string, path: string, scope: MemoryScope): MemoryDocument {
  const lines = content.split(/\r?\n/);
  const parsed = frontmatter(lines);
  const metadata = parsed.error ? {} : parsed.metadata;
  const type =
    typeof metadata.type === 'string' && TYPES.includes(metadata.type as MemoryType)
      ? (metadata.type as MemoryType)
      : scope === 'user'
        ? 'user'
        : 'project';
  const readTitle = headingReader();
  const legacyTitle = lines
    .slice(parsed.bodyStart)
    .map(readTitle)
    .find((heading) => heading?.level === 1)?.title;
  const title =
    typeof metadata.title === 'string' && metadata.title.trim()
      ? metadata.title.trim()
      : (legacyTitle ?? basename(path, '.md').replace(/[-_]+/g, ' '));
  const description = typeof metadata.description === 'string' ? metadata.description.trim() : '';
  const updated = typeof metadata.updated === 'string' ? metadata.updated.trim() : '';
  const chunks: MemoryChunk[] = [];
  const headings: string[] = [];
  const readHeading = headingReader();
  let heading = title;
  let current: Array<{ line: string; number: number; heading: boolean }> = [];
  let length = 0;
  const flush = () => {
    const text = current
      .map((row) => row.line)
      .join('\n')
      .trim();
    if (text && current.some((row) => row.line.trim() && !row.heading))
      chunks.push({
        ordinal: chunks.length,
        startLine: current[0]!.number,
        endLine: current.at(-1)!.number,
        heading,
        content: text,
        embeddingText: [title, description, heading, text].filter(Boolean).join('\n'),
      });
    current = [];
    length = 0;
  };
  for (let index = parsed.bodyStart; index < lines.length; index++) {
    const line = lines[index]!;
    const found = readHeading(line);
    if (found) {
      flush();
      headings.length = found.level;
      headings[found.level - 1] = found.title;
      heading = headings.filter(Boolean).join(' > ');
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    if (line.length > CHUNK_CHAR_LIMIT) {
      flush();
      for (let offset = 0; offset < line.length; offset += CHUNK_CHAR_LIMIT) {
        current.push({ line: line.slice(offset, offset + CHUNK_CHAR_LIMIT), number: index + 1, heading: found !== null });
        flush();
      }
      continue;
    }
    if (length + line.length + 1 > CHUNK_CHAR_LIMIT) flush();
    current.push({ line, number: index + 1, heading: found !== null });
    length += line.length + 1;
  }
  flush();
  return { type, title, description, updated, chunks };
}
