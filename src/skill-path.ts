/**
 * The skill a recorded file access belongs to: any path running through a
 * skills/ directory (the global skills folder, a workspace .agents/skills, or
 * a repository's own skills/). Kept beside the action row at write time so
 * skill usage is recorded data, not a report-time guess.
 */
export function skillNameFromPath(path: string | null | undefined): string | null {
  if (!path) return null;
  const normalized = path.replace(/\\/g, '/');
  const marker = normalized.toLowerCase().indexOf('/skills/');
  if (marker < 0) return null;
  const segment = normalized.slice(marker + '/skills/'.length).split('/')[0];
  return segment && segment !== 'SKILL.md' ? segment : null;
}
