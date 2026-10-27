import { describe, expect, it } from 'vitest';
import { buildActionsReport, skillNameFromPath, type ActionFact } from '../src/usage/actions-report.js';

const fact = (providerId: string, toolName: string, state = 'completed', path?: string): ActionFact => ({
  providerId,
  toolName,
  state,
  createdAt: '2026-10-27T00:00:00.000Z',
  path: path ?? null,
});

describe('skillNameFromPath', () => {
  it('names the skill directory a file access runs through', () => {
    expect(skillNameFromPath('C:\\Users\\x\\AppData\\Local\\ranite\\skills\\skill-creator\\SKILL.md')).toBe('skill-creator');
    expect(skillNameFromPath('/repo/.agents/skills/bug-reaper/references/cases.md')).toBe('bug-reaper');
    expect(skillNameFromPath('/repo/skills/ranite/SKILL.md')).toBe('ranite');
  });

  it('leaves ordinary files and missing paths alone', () => {
    expect(skillNameFromPath('C:\\repo\\src\\agent-session.ts')).toBeNull();
    expect(skillNameFromPath('/repo/docs/skills.md')).toBeNull();
    expect(skillNameFromPath(null)).toBeNull();
    expect(skillNameFromPath(undefined)).toBeNull();
  });
});

describe('buildActionsReport', () => {
  it('keeps every tool, server and skill as its own counted row', () => {
    const facts: ActionFact[] = [
      fact('host', 'file_read', 'completed', 'C:\\repo\\skills\\demo\\SKILL.md'),
      fact('host', 'file_read', 'completed', 'C:\\repo\\skills\\demo\\SKILL.md'),
      fact('host', 'execute_command', 'failed'),
      fact('host', 'execute_command', 'completed'),
      fact('playwright', 'browser_navigate', 'completed'),
      fact('playwright', 'browser_click', 'completed'),
      fact('athena', 'athena_search', 'completed'),
    ];
    const report = buildActionsReport(facts, '2026-10-01T00:00:00.000Z');

    expect(report.windowCalls).toBe(7);
    expect(report.windowFailed).toBe(1);
    expect(report.tools.find((tool) => tool.tool === 'file_read')).toMatchObject({ provider: 'host', calls: 2, failed: 0 });
    expect(report.tools.find((tool) => tool.tool === 'execute_command')).toMatchObject({ calls: 2, failed: 1 });

    expect(report.mcp.map((server) => [server.server, server.calls])).toEqual([
      ['playwright', 2],
      ['athena', 1],
    ]);
    expect(report.mcp.some((server) => server.server === 'host')).toBe(false);

    expect(report.skills).toEqual([{ skill: 'demo', uses: 2 }]);
  });

  it('sorts by calls and reports an empty window honestly', () => {
    const facts: ActionFact[] = [fact('host', 'glob'), fact('host', 'glob'), fact('host', 'grep')];
    const report = buildActionsReport(facts, '2026-10-01T00:00:00.000Z');
    expect(report.tools.map((tool) => tool.tool)).toEqual(['glob', 'grep']);
    expect(report.mcp).toEqual([]);
    expect(report.skills).toEqual([]);

    const empty = buildActionsReport([], '2026-10-01T00:00:00.000Z');
    expect(empty).toMatchObject({ windowCalls: 0, windowFailed: 0, tools: [], mcp: [], skills: [] });
  });
});
