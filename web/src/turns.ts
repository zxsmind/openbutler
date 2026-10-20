import type { Entry } from './types.js';

export interface Turn {
  id: string;
  user: Entry | null;
  steps: Entry[];
  assistant: Entry[];
  timeline: Entry[];
  notices: Entry[];
  startedAt: number | null;
  endedAt: number | null;
  toolCount: number;
  failedCount: number;
}

function isStep(entry: Entry): boolean {
  return entry.kind === 'reasoning' || entry.kind === 'tool';
}

function failed(entry: Entry): boolean {
  if (entry.kind !== 'tool') return false;
  const text = `${entry.result ?? ''}`.toLowerCase();
  return /^error|failed|not permitted|refused|denied/.test(text) || text.includes('exit 1');
}

/**
 * A turn is one owner message and everything the agent did for it. Grouping is
 * what turns a flat log into readable work: the header answers "what did I ask",
 * the steps answer "what happened", the assistant text answers "what came back".
 */
export function buildTurns(entries: Entry[], base = 0): Turn[] {
  const turns: Turn[] = [];
  let current: Turn | null = null;

  const open = (entry: Entry | null, index: number): Turn => {
    const turn: Turn = {
      id: entry?.turnId ?? entry?.eventId ?? `turn-${base + index}`,
      user: null,
      steps: [],
      assistant: [],
      timeline: [],
      notices: [],
      startedAt: entry?.at ?? null,
      endedAt: null,
      toolCount: 0,
      failedCount: 0,
    };
    turns.push(turn);
    return turn;
  };

  for (const [index, entry] of entries.entries()) {
    if (entry.kind === 'user') {
      current = open(entry, index);
      current.user = entry;
      continue;
    }
    if (!current) current = open(null, index);
    current.timeline.push(entry);
    if (entry.at && current.startedAt === null) current.startedAt = entry.at;
    if (entry.at) current.endedAt = entry.at;

    if (isStep(entry)) {
      current.steps.push(entry);
      if (entry.kind === 'tool') {
        current.toolCount += 1;
        if (failed(entry)) current.failedCount += 1;
      }
      continue;
    }
    if (entry.kind === 'assistant') {
      current.assistant.push(entry);
      continue;
    }
    current.notices.push(entry);
  }

  return turns;
}

export function turnDuration(turn: Turn): number | null {
  if (turn.startedAt === null || turn.endedAt === null) return null;
  return Math.max(0, turn.endedAt - turn.startedAt);
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(1, Math.round(ms / 100)) / 10}s`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${Math.round(seconds - minutes * 60)}s`;
}

/** Short, stable label for a tool call: the verb plus its target. */
export function stepLabel(entry: Entry): { verb: string; target: string } {
  if (entry.kind === 'reasoning') return { verb: 'Thought', target: '' };
  const command = entry.command ?? entry.tool ?? 'tool';
  const space = command.indexOf(' ');
  if (space === -1) return { verb: command, target: '' };
  return { verb: command.slice(0, space), target: command.slice(space + 1) };
}

export function turnSummary(turn: Turn): string {
  const parts: string[] = [];
  if (turn.toolCount > 0) parts.push(`${turn.toolCount} step${turn.toolCount === 1 ? '' : 's'}`);
  if (turn.failedCount > 0) parts.push(`${turn.failedCount} failed`);
  const duration = turnDuration(turn);
  if (duration !== null) parts.push(formatDuration(duration));
  return parts.join(' · ');
}
