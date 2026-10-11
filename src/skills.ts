import { closeSync, existsSync, lstatSync, openSync, readSync, readdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load as parseYaml } from 'js-yaml';
import { getDataPath } from './paths.js';

export interface AgentSkill {
  name: string;
  description: string;
  filePath: string;
  scope: 'builtin' | 'global' | 'workspace';
}

export interface SkillRoot {
  path: string;
  scope: AgentSkill['scope'];
}

const MAX_SKILLS_PER_SCOPE = 128;
const MAX_SKILL_FRONTMATTER_BYTES = 8 * 1024;
const MAX_SKILL_INDEX_CHARS = 8 * 1024;
const SKILL_DISCOVERY_CACHE_MS = 5_000;
const discoveryCache = new Map<string, { expiresAt: number; skills: AgentSkill[] }>();

function builtinSkillDirectory(): string {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const packaged = join(moduleDirectory, 'builtin-skills');
  return existsSync(packaged) ? packaged : resolve(moduleDirectory, '../skills');
}

export function getRaniteSkillDirectory(): string {
  return getDataPath('skills');
}

/** Bundled skills, user-level skills, then workspace skills; later roots override duplicate names. */
export function getSkillRoots(workspaceRoot = process.cwd()): SkillRoot[] {
  const home = homedir();
  const codexHome = process.env.CODEX_HOME || join(home, '.codex');
  return [
    { path: builtinSkillDirectory(), scope: 'builtin' },
    { path: join(home, '.claude', 'skills'), scope: 'global' },
    { path: join(home, '.agents', 'skills'), scope: 'global' },
    { path: join(codexHome, 'skills'), scope: 'global' },
    { path: getDataPath('skills'), scope: 'global' },
    { path: resolve(workspaceRoot, '.claude', 'skills'), scope: 'workspace' },
    { path: resolve(workspaceRoot, '.agents', 'skills'), scope: 'workspace' },
  ];
}

/** Metadata only: skill instructions and references stay unloaded until needed. */
export function discoverSkills(workspaceRoot = process.cwd()): AgentSkill[] {
  const cacheKey = resolve(workspaceRoot);
  const cached = discoveryCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.skills;

  const skills = new Map<string, AgentSkill>();
  const scopeCounts: Record<AgentSkill['scope'], number> = { builtin: 0, global: 0, workspace: 0 };
  for (const root of getSkillRoots(workspaceRoot)) {
    let entries;
    try {
      entries = readdirSync(root.path, { withFileTypes: true });
    } catch (error) {
      if (isMissingOrDenied(error)) continue;
      throw error;
    }

    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (!entry.isDirectory() || !isSkillName(entry.name)) continue;
      const existing = skills.has(entry.name);
      if (!existing && scopeCounts[root.scope] >= MAX_SKILLS_PER_SCOPE) continue;
      const filePath = join(root.path, entry.name, 'SKILL.md');
      const metadata = readSkillMetadata(filePath);
      if (!metadata || metadata.name !== entry.name) continue;
      if (!existing) scopeCounts[root.scope] += 1;
      skills.set(metadata.name, { ...metadata, filePath, scope: root.scope });
    }
  }
  const discovered = [...skills.values()].sort(
    (left, right) => scopeRank(left.scope) - scopeRank(right.scope) || left.name.localeCompare(right.name),
  );
  discoveryCache.delete(cacheKey);
  discoveryCache.set(cacheKey, { expiresAt: Date.now() + SKILL_DISCOVERY_CACHE_MS, skills: discovered });
  while (discoveryCache.size > 16) {
    const oldest = discoveryCache.keys().next().value;
    if (oldest === undefined) break;
    discoveryCache.delete(oldest);
  }
  return discovered;
}

export function formatSkillIndex(skills: readonly AgentSkill[]): string {
  const lines: string[] = [];
  let length = 0;
  for (const skill of skills) {
    const line = '- ' + skill.name + ' [' + skill.scope + ']: ' + skill.description + ' (read ' + skill.filePath + ' to load instructions)';
    if (length + line.length + (lines.length > 0 ? 1 : 0) > MAX_SKILL_INDEX_CHARS) break;
    lines.push(line);
    length += line.length + (lines.length > 1 ? 1 : 0);
  }
  return lines.join('\n');
}

/** Only files within valid bundled or user-level skill packages are pre-authorized for read. */
export function isTrustedSkillResourcePath(source: string, workspaceRoot = process.cwd()): boolean {
  let target: string;
  try {
    target = realpathSync(resolve(source));
  } catch {
    return false;
  }
  for (const root of getSkillRoots(workspaceRoot).filter((entry) => entry.scope !== 'workspace')) {
    try {
      const realRoot = realpathSync(root.path);
      const skillName = relative(realRoot, target).split(sep)[0] ?? '';
      if (!isSkillName(skillName)) continue;
      const skillDirectory = realpathSync(join(realRoot, skillName));
      const metadata = readSkillMetadata(join(skillDirectory, 'SKILL.md'));
      if (metadata?.name === skillName && isWithin(skillDirectory, target)) return true;
    } catch {
      // A missing optional skill root is not an approval scope.
    }
  }
  return false;
}

function scopeRank(scope: AgentSkill['scope']): number {
  return scope === 'builtin' ? 0 : scope === 'workspace' ? 1 : 2;
}

function readSkillMetadata(path: string): Pick<AgentSkill, 'name' | 'description'> | null {
  let descriptor: number;
  try {
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink()) return null;
    descriptor = openSync(path, 'r');
  } catch {
    return null;
  }

  let source: string;
  try {
    const buffer = Buffer.allocUnsafe(MAX_SKILL_FRONTMATTER_BYTES);
    const bytesRead = readSync(descriptor, buffer, 0, buffer.byteLength, 0);
    source = buffer.toString('utf8', 0, bytesRead);
  } finally {
    closeSync(descriptor);
  }

  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(source)?.[1];
  if (!frontmatter) return null;
  let metadata: unknown;
  try {
    metadata = parseYaml(frontmatter);
  } catch {
    return null;
  }
  if (!isRecord(metadata) || typeof metadata.name !== 'string' || typeof metadata.description !== 'string') return null;
  const name = metadata.name;
  const description = metadata.description.trim();
  if (!isSkillName(name) || description.length === 0 || description.length > 1_024) return null;
  return { name, description };
}

function isSkillName(name: string): boolean {
  return name.length <= 64 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isMissingOrDenied(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error.code === 'ENOENT' || error.code === 'EACCES' || error.code === 'EPERM')
  );
}

function isWithin(root: string, target: string): boolean {
  const relativePath = relative(root, target);
  return relativePath === '' || (relativePath !== '..' && !relativePath.startsWith('..' + sep) && !isAbsolute(relativePath));
}
