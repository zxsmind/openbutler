/**
 * Counts recorded tool activity per tool, per MCP server and per skill, from
 * the action ledger's stored rows. Every dimension keeps its own row: "402
 * file_read calls" and "130 playwright calls" stay separately queryable instead
 * of collapsing into a single total.
 */

/** One fact per recorded action; everything the report needs, nothing more. */
export interface ActionFact {
  providerId: string;
  toolName: string;
  state: string;
  createdAt: string;
  /** The input's `path` for file tools; null for everything else. */
  path?: string | null;
}

export interface ToolStat {
  provider: string;
  tool: string;
  calls: number;
  failed: number;
}

export interface McpStat {
  server: string;
  calls: number;
  tools: ToolStat[];
}

export interface SkillStat {
  skill: string;
  uses: number;
}

export interface ActionsReport {
  since: string;
  windowCalls: number;
  windowFailed: number;
  tools: ToolStat[];
  mcp: McpStat[];
  skills: SkillStat[];
}

/**
 * The skill a recorded file access belongs to: paths that run through a
 * skills/ directory (the global skills folder, a workspace .agents/skills, or
 * the repository's own skills/). Null for every other path.
 */
export function skillNameFromPath(path: string | null | undefined): string | null {
  if (!path) return null;
  const normalized = path.replace(/\\/g, '/');
  const marker = normalized.toLowerCase().indexOf('/skills/');
  if (marker < 0) return null;
  const segment = normalized.slice(marker + '/skills/'.length).split('/')[0];
  return segment && segment !== 'SKILL.md' ? segment : null;
}

/** Per-tool counts with failures kept visible; MCP servers exclude host tools; skills count path touches. */
export function buildActionsReport(facts: readonly ActionFact[], since: string): ActionsReport {
  const tools = new Map<string, ToolStat>();
  const skills = new Map<string, SkillStat>();
  let windowCalls = 0;
  let windowFailed = 0;
  for (const fact of facts) {
    windowCalls += 1;
    const failed = fact.state === 'failed';
    if (failed) windowFailed += 1;
    const key = `${fact.providerId}::${fact.toolName}`;
    const stat = tools.get(key) ?? { provider: fact.providerId, tool: fact.toolName, calls: 0, failed: 0 };
    stat.calls += 1;
    if (failed) stat.failed += 1;
    tools.set(key, stat);
    const skill = skillNameFromPath(fact.path);
    if (skill) {
      const skillStat = skills.get(skill) ?? { skill, uses: 0 };
      skillStat.uses += 1;
      skills.set(skill, skillStat);
    }
  }
  const toolList = [...tools.values()].sort(
    (left, right) => right.calls - left.calls || left.provider.localeCompare(right.provider) || left.tool.localeCompare(right.tool),
  );
  const byServer = new Map<string, ToolStat[]>();
  for (const stat of toolList) {
    if (stat.provider === 'host') continue;
    byServer.set(stat.provider, [...(byServer.get(stat.provider) ?? []), stat]);
  }
  const mcp: McpStat[] = [...byServer.entries()]
    .map(([server, serverTools]) => ({ server, calls: serverTools.reduce((sum, stat) => sum + stat.calls, 0), tools: serverTools }))
    .sort((left, right) => right.calls - left.calls);
  const skillList = [...skills.values()].sort((left, right) => right.uses - left.uses || left.skill.localeCompare(right.skill));
  return { since, windowCalls, windowFailed, tools: toolList, mcp, skills: skillList };
}
