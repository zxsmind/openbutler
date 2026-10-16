import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { getTeamMemoryPaths } from '../memory-paths.js';
import type { TeamMemoryEntry, TeamMemoryTopic } from './session.js';

const TITLES: Record<TeamMemoryTopic, string> = { decisions: 'Team decisions', shared: 'Shared team memory' };
const DESCRIPTIONS: Record<TeamMemoryTopic, string> = {
  decisions: 'Decisions the team agreed on, oldest first, each signed with its author and date.',
  shared: 'Shared facts the team wants everyone to know, oldest first, each signed with its author and date.',
};

/** One line per entry: `- [YYYY-MM-DD · author] body`. Newlines collapse so each entry stays one bullet. */
function entryLine(entry: TeamMemoryEntry): string {
  const date = new Date(entry.createdAt).toISOString().slice(0, 10);
  const body = entry.body
    .replace(/\r?\n+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return `- [${date} · ${entry.author}] ${body}`;
}

/**
 * Renders one topic's entries as a valid memory document. The file is a
 * materialized view of the hub's log, so it carries no facts of its own.
 */
export function renderTeamMemoryFile(topic: TeamMemoryTopic, entries: TeamMemoryEntry[], updated: string): string {
  const relevant = entries.filter((entry) => entry.topic === topic);
  const bullets = relevant.length > 0 ? relevant.map(entryLine).join('\n') : '- (No entries yet.)';
  return `---
title: ${TITLES[topic]}
description: ${DESCRIPTIONS[topic]}
updated: ${updated}
type: reference
---
# ${TITLES[topic]}

${TITLES[topic]} agreed by the team. Each line is signed with its author and date; nothing is deleted, a changed decision gets a new line.

${bullets}
`;
}

function atomicWrite(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, content, 'utf8');
  renameSync(temporary, path);
}

/**
 * Materializes both team memory files on this machine from the hub's log.
 * Called on the member poll and after a local write, so the local files the
 * agent reads and searches always reflect the shared truth.
 */
export function materializeTeamMemory(teamKey: string, entries: TeamMemoryEntry[], updated: string, workspaceRoot = process.cwd()): void {
  const paths = getTeamMemoryPaths(teamKey, workspaceRoot);
  atomicWrite(paths.decisionsFile, renderTeamMemoryFile('decisions', entries, updated));
  atomicWrite(paths.sharedFile, renderTeamMemoryFile('shared', entries, updated));
}
