import { JSON_SCHEMA, load } from 'js-yaml';
import { basename } from 'node:path';

export const MEMORY_DOCUMENT_REVISION = 'markdown-v2';
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
  chunks: MemoryChunk[];
}

export const MEMORY_DOCUMENT_GUIDANCE = `Memory is Markdown under the persistent memory root: shared user facts in user/profile.md and user/notes/, active-workspace facts in workspaces/<workspace-key>/profile.md and its notes/. Folder placement defines scope; frontmatter cannot change it. Profiles collect stable facts; topic notes hold explanations, decisions, recurring issues, and reference material. Do not create extra indexes or empty placeholder notes. MEMORY.md is the single cross-workspace index, capped at ${MEMORY_INDEX_MAX_LINES} lines and ${Math.floor(MEMORY_INDEX_MAX_BYTES / 1024)} KB.

Every profile and topic note is a Markdown document:

    ---
    type: feedback
    title: <document title>
    description: <what this document covers>
    ---
    # <document title>
    ## <subject area>
    ### <memory title>
    #### Summary
    <the fact and when it applies>
    #### Details
    <concrete scope, conditions, identifiers, reasons, current state, and open questions, when known>
    #### Evidence
    <the source, date, or correction that grounds it; omit when unavailable>

- type is user (personal facts and preferences), feedback (corrections and confirmed approaches), project (project or workspace state), or reference (useful external locations). A user profile uses type: user; a workspace profile uses type: project.
- title is required, at most 160 characters; description is required, at most 500 characters. The H1 must equal title, every H3 entry needs a non-empty #### Summary, H4 sections only belong inside an H3 entry, and heading levels never skip.
- Filenames are descriptive English kebab-case, for example user/notes/workspace-file-hygiene.md; subdirectories under notes/ follow the same style, and profile.md is reserved for profiles.
- Write bodies in English so the local embedding model can find them, preserving exact identifiers and user quotations as written. The placeholders above describe structure, not facts to save.

Writing rules:
- Read a document before changing it. When a fact or preference changes, update the entry it affects, merge duplicates, say what the change supersedes, and split unrelated subjects into separate topic files.
- Save only durable information that cannot be derived from the current repository or reread from a primary source.
- Record uncertainty and provenance instead of guessing, keep an explicit preference, a verified fact, a historical observation, and an unresolved assumption distinct, and never assume an imported project fact with no recorded workspace describes the active workspace.
- Never store credentials, secrets, raw file contents, image data, transient chat, or raw tool output.
- MEMORY.md entries are one line each: - [<title>](<user-scope path>) — <brief signal>, linking only user/profile.md or existing user/notes/*.md files. The signal is the short phrase needed in ordinary replies; detailed facts stay in the linked note. Workspace facts stay in the active workspace scope and are never linked from this index. A native write adds the entry for a new user-scope document automatically; do not duplicate it.`;

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
  const { type, title, description } = parsed.metadata;
  if (typeof type !== 'string' || !TYPES.includes(type as MemoryType)) errors.push('type must be user, feedback, project, or reference.');
  if (expectedProfileType && type !== expectedProfileType) errors.push(`This profile requires type: ${expectedProfileType}.`);
  if (typeof title !== 'string' || !title.trim() || title.length > 160)
    errors.push('title must be a non-empty string of at most 160 characters.');
  if (typeof description !== 'string' || !description.trim() || description.length > 500)
    errors.push('description must be a non-empty string of at most 500 characters.');
  const readHeading = headingReader();
  let previousLevel = 0;
  let documentTitles = 0;
  let topicSeen = false;
  let item: { title: string; hasSummary: boolean; summaryHasContent: boolean } | null = null;
  let inSummary = false;
  let itemCount = 0;
  const finishItem = () => {
    if (item && (!item.hasSummary || !item.summaryHasContent)) errors.push(`Memory "${item.title}" requires a non-empty #### Summary.`);
    item = null;
    inSummary = false;
  };
  for (let index = parsed.bodyStart; index < lines.length; index++) {
    const line = lines[index]!;
    const heading = readHeading(line);
    if (!heading) {
      if (inSummary && item && line.trim() && !/^\s*(`{3,}|~{3,})/.test(line)) item.summaryHasContent = true;
      continue;
    }
    if (heading.level > previousLevel + 1) errors.push(`Line ${index + 1}: headings must not skip a level.`);
    previousLevel = heading.level;
    if (heading.level <= 3) finishItem();
    if (heading.level === 1) {
      documentTitles++;
      if (heading.title !== title) errors.push('The H1 must match the frontmatter title.');
    } else if (heading.level === 2) topicSeen = true;
    else if (heading.level === 3) {
      if (!topicSeen) errors.push('Each H3 memory must be inside an H2 subject area.');
      item = { title: heading.title, hasSummary: false, summaryHasContent: false };
      itemCount++;
    } else if (heading.level === 4) {
      if (!item) errors.push(`Line ${index + 1}: H4 sections must belong to an H3 memory.`);
      inSummary = heading.title === 'Summary';
      if (inSummary && item) item.hasSummary = true;
    } else inSummary = false;
  }
  finishItem();
  if (documentTitles !== 1) errors.push('Use exactly one H1 document title.');
  if (!itemCount) errors.push('Add at least one H3 memory item under an H2 subject area.');
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
    const entry = /^-\s+\[([^\]]+)\]\(([^)\s]+)\)\s*(?:—|-|:)\s+(.+)$/.exec(line);
    if (!entry) {
      errors.push(`Line ${index + 1}: use one Markdown link and a brief user signal per index entry.`);
      continue;
    }
    const path = entry[2]!;
    if (path !== 'user/profile.md' && !(path.startsWith('user/notes/') && validateMemoryNoteName(path.slice('user/notes/'.length)))) {
      errors.push(
        `Line ${index + 1}: index links must target user/profile.md or user/notes/*.md. Workspace notes are discovered through the active workspace path.`,
      );
    }
  }
  if (titles !== 1) errors.push('The memory index requires exactly one H1 title.');
  return errors;
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
  return { type, title, description, chunks };
}
