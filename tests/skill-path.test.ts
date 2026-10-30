import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { ActivityLedger, type ToolActionUpdate } from '../src/activity-ledger.js';
import { skillNameFromPath } from '../src/skill-path.js';

const effect = { change: 'none', data: 'sensitive', network: 'none', reversible: 'full', outbound: 'model' } as const;
const temporary: string[] = [];

afterEach(() => {
  while (temporary.length) rmSync(temporary.pop()!, { recursive: true, force: true });
});

function tempDb(): string {
  const directory = mkdtempSync(join(tmpdir(), 'openbutler-skill-path-'));
  temporary.push(directory);
  return join(directory, 'state.db');
}

function update(name: string, input: Record<string, unknown>): ToolActionUpdate {
  return {
    requestId: `skill-${name}`,
    workspaceRoot: 'C:\\repo',
    sessionId: 'session-1',
    providerId: 'host',
    name,
    input,
    effect,
    state: 'proposed',
  };
}

describe('skillNameFromPath', () => {
  it('names the skill directory a file access runs through', () => {
    expect(skillNameFromPath('C:\\Users\\x\\AppData\\Local\\openbutler\\skills\\skill-creator\\SKILL.md')).toBe('skill-creator');
    expect(skillNameFromPath('/repo/.agents/skills/bug-reaper/references/cases.md')).toBe('bug-reaper');
    expect(skillNameFromPath('/repo/skills/openbutler/SKILL.md')).toBe('openbutler');
  });

  it('leaves ordinary files and missing paths alone', () => {
    expect(skillNameFromPath('C:\\repo\\src\\agent-session.ts')).toBeNull();
    expect(skillNameFromPath('/repo/docs/skills.md')).toBeNull();
    expect(skillNameFromPath(null)).toBeNull();
    expect(skillNameFromPath(undefined)).toBeNull();
  });
});

describe('recorded skill column', () => {
  it('stores the skill beside the action when the input path runs through skills/', () => {
    const path = tempDb();
    const ledger = new ActivityLedger(path);
    try {
      ledger.recordToolAction(update('with-skill', { path: 'C:\\repo\\skills\\demo\\SKILL.md' }));
      ledger.recordToolAction(update('without-skill', { path: 'C:\\repo\\src\\agent.ts' }));
    } finally {
      ledger.close();
    }
    const database = new DatabaseSync(path, { readOnly: true });
    try {
      const rows = database.prepare('SELECT request_id, skill FROM openbutler_actions ORDER BY request_id').all() as Array<{
        request_id: string;
        skill: string | null;
      }>;
      expect(rows).toEqual([
        { request_id: 'skill-with-skill', skill: 'demo' },
        { request_id: 'skill-without-skill', skill: null },
      ]);
    } finally {
      database.close();
    }
  });

  it('adds the column to an existing ledger and backfills history from stored paths', () => {
    const path = tempDb();
    const database = new DatabaseSync(path);
    database.exec(`
      CREATE TABLE openbutler_actions (
        request_id TEXT PRIMARY KEY,
        workspace_root TEXT NOT NULL,
        session_id TEXT NOT NULL,
        provider_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        state TEXT NOT NULL,
        input_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO openbutler_actions (request_id, workspace_root, session_id, provider_id, tool_name, state, input_json, created_at, updated_at)
      VALUES
        ('old-skill', 'C:\\repo', 's', 'host', 'file_read', 'completed', '{"path":"C:\\\\repo\\\\skills\\\\legacy\\\\SKILL.md"}', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z'),
        ('old-plain', 'C:\\repo', 's', 'host', 'grep', 'completed', '{"pattern":"x"}', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z');
    `);
    database.close();

    const ledger = new ActivityLedger(path);
    try {
      const columns = ledger['database'].prepare('PRAGMA table_info(openbutler_actions)').all() as Array<{ name: string }>;
      expect(columns.some((column) => column.name === 'skill')).toBe(true);
      const rows = ledger['database'].prepare('SELECT request_id, skill FROM openbutler_actions ORDER BY request_id').all() as Array<{
        request_id: string;
        skill: string | null;
      }>;
      expect(rows).toEqual([
        { request_id: 'old-plain', skill: null },
        { request_id: 'old-skill', skill: 'legacy' },
      ]);
    } finally {
      ledger.close();
    }
  });
});
