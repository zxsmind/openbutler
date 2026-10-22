import type { Entry } from './types.js';
export { reasoningSentences, thoughtHeadline } from './reasoning-headline.js';

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
  // The turn being built, so a message the owner sent into a run that was still
  // going stays in that turn instead of opening a new one.
  let currentTurnId: string | undefined;
  // Turn ids double as virtual-list keys, so they must stay unique even when the
  // transcript carries one turn id across several messages.
  const used = new Set<string>();
  // Turns by the id their entries carry, so an entry that names its turn lands
  // there even when the array placed it a little earlier than its message.
  const byTurn = new Map<string, Turn>();

  const open = (entry: Entry | null, index: number): Turn => {
    const wanted = entry?.turnId ?? entry?.eventId ?? `turn-${base + index}`;
    const id = used.has(wanted) ? `${wanted}-${base + index}` : wanted;
    used.add(id);
    const turn: Turn = {
      id,
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
    if (entry?.turnId !== undefined) byTurn.set(entry.turnId, turn);
    return turn;
  };

  for (const [index, entry] of entries.entries()) {
    // Text the machinery wrote is stored so the record stays complete, but it is
    // not part of the conversation: the compaction row already carries the event,
    // and the checkpoint prose would read as an answer nobody asked for.
    if (entry.internal === 'compaction') continue;
    if (entry.kind === 'user' && (entry.turnId === undefined || entry.turnId !== currentTurnId)) {
      current = open(entry, index);
      current.user = entry;
      currentTurnId = entry.turnId;
      continue;
    }
    if (!current) {
      current = open(null, index);
      currentTurnId = undefined;
    }
    // An entry that names a turn belongs to that turn. Falling back to position
    // alone is what put a fresh thought above the message that asked for it.
    if (entry.turnId !== undefined && entry.turnId !== currentTurnId) {
      const named = byTurn.get(entry.turnId);
      if (named) {
        current = named;
        currentTurnId = entry.turnId;
      }
    }
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

/**
 * True while the owner's message has been taken and nothing has come back for
 * it yet. That window is the only honest place for a "working" dot: once the
 * first chunk lands, the answer itself is the feedback.
 */
export function awaitingFirstChunk(turns: Turn[], liveTurnId: string | undefined): boolean {
  if (liveTurnId === undefined) return false;
  const last = turns[turns.length - 1];
  return last !== undefined && last.id === liveTurnId && last.timeline.length === 0;
}

export type TurnGroup = { kind: 'steps'; entries: Entry[] } | { kind: 'message'; entry: Entry } | { kind: 'compaction'; entry: Entry };
/** Work and diagnostics share a group; only conversation messages close it. */
export function groupTimeline(turn: Turn): TurnGroup[] {
  const groups: TurnGroup[] = [];
  for (const entry of turn.timeline) {
    if (entry.kind === 'user' || entry.kind === 'assistant') {
      groups.push({ kind: 'message', entry });
      continue;
    }
    // Compaction is its own event: it is not work the agent did, and folding it
    // into a step group would hide the moment the context changed.
    if (entry.kind === 'compaction') {
      groups.push({ kind: 'compaction', entry });
      continue;
    }
    const previous = groups[groups.length - 1];
    if (previous?.kind === 'steps') previous.entries.push(entry);
    else groups.push({ kind: 'steps', entries: [entry] });
  }
  return groups;
}

/**
 * The newest step group of the newest turn is the one still being written to,
 * so it is the only group that opens by itself. Starting the next group folds
 * the previous one; older turns stay folded until the reader opens them.
 */
export function activeGroupIndex(groups: readonly TurnGroup[], current: boolean): number {
  if (!current) return -1;
  // Only work that is still the newest thing in the turn stays open. Once the
  // answer starts streaming after it, that work is history: it folds so the
  // reader reads the text, not the log of how it was produced.
  const last = groups[groups.length - 1];
  return last?.kind === 'steps' ? groups.length - 1 : -1;
}

/** A thinking block names its own duration, the way the terminal header does. */
export function thoughtLabel(durationMs: number | undefined): string {
  return durationMs === undefined ? 'Thought' : `Thought for ${formatDuration(durationMs)}`;
}

/** Total thinking time in a group; unknown as soon as one block is unstamped. */
export function thoughtDuration(entries: readonly Entry[]): number | undefined {
  let total = 0;
  let blocks = 0;
  for (const entry of entries) {
    if (entry.kind !== 'reasoning') continue;
    if (entry.durationMs === undefined) return undefined;
    total += entry.durationMs;
    blocks += 1;
  }
  return blocks === 0 ? undefined : total;
}

/** What a step actually did, so a group can say "3 komut" instead of "Komutlar". */
export type ToolCategory =
  | 'command'
  | 'browser'
  | 'read'
  | 'write'
  | 'search'
  | 'image'
  | 'skill'
  | 'memory'
  | 'team'
  | 'agent'
  | 'session'
  | 'message'
  | 'schedule'
  | 'tool';

const CATEGORY_WORDS: Record<ToolCategory, { one: string; many: string; done: string; running: string }> = {
  command: { one: 'command', many: 'commands', done: 'run', running: 'running' },
  browser: { one: 'browser call', many: 'browser calls', done: 'made', running: 'in progress' },
  read: { one: 'file', many: 'files', done: 'read', running: 'being read' },
  write: { one: 'file', many: 'files', done: 'written', running: 'being written' },
  search: { one: 'search', many: 'searches', done: 'done', running: 'running' },
  image: { one: 'image', many: 'images', done: 'loaded', running: 'loading' },
  skill: { one: 'skill', many: 'skills', done: 'read', running: 'being read' },
  memory: { one: 'memory operation', many: 'memory operations', done: 'done', running: 'running' },
  team: { one: 'team message', many: 'team messages', done: 'sent', running: 'sending' },
  agent: { one: 'subagent task', many: 'subagent tasks', done: 'run', running: 'running' },
  session: { one: 'session read', many: 'session reads', done: 'done', running: 'running' },
  message: { one: 'message', many: 'messages', done: 'sent', running: 'sending' },
  schedule: { one: 'schedule', many: 'schedules', done: 'updated', running: 'updating' },
  tool: { one: 'tool', many: 'tools', done: 'run', running: 'running' },
};

const IMAGE_FILE = /\.(?:png|jpe?g|gif|webp|avif)\b/i;

/** A tool call's identity is `provider:name`; the display command carries the path. */
export function classifyTool(entry: Entry): ToolCategory {
  const [provider = '', name = ''] = (entry.tool ?? '').toLowerCase().split(':');
  const command = entry.command ?? '';
  if (provider === 'host') {
    if (name === 'execute_command') return 'command';
    if (name === 'file_read') {
      if (/SKILL\.md/i.test(command)) return 'skill';
      if (IMAGE_FILE.test(command)) return 'image';
      return 'read';
    }
    if (name === 'file_write' || name === 'file_edit') return 'write';
    if (name === 'glob' || name === 'grep') return 'search';
    if (name.startsWith('memory_')) return 'memory';
    if (name.startsWith('team_')) return 'team';
    if (name === 'subagent' || name === 'subagent_stop' || name === 'parent_message') return 'agent';
    if (name.startsWith('session_')) return 'session';
    if (name === 'inbox' || name === 'send_message_to_owner' || name === 'session_message') return 'message';
    if (name === 'schedule') return 'schedule';
    return 'tool';
  }
  if (/playwright|chrome|browser|cua/.test(provider)) return 'browser';
  return 'tool';
}

function countByCategory(entries: readonly Entry[], verb: 'done' | 'running'): string[] {
  const counts = new Map<ToolCategory, number>();
  for (const entry of entries) {
    const category = classifyTool(entry);
    counts.set(category, (counts.get(category) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1])
    .map(([category, count]) => {
      const words = CATEGORY_WORDS[category];
      return `${count} ${count === 1 ? words.one : words.many} ${words[verb]}`;
    });
}

/**
 * What the group did, counted: "2 commands running, 4 commands run".
 * Work in flight comes first, because that is the part still changing.
 */
export function groupSummary(entries: readonly Entry[], maxParts = 3): string {
  const tools = entries.filter((entry) => entry.kind === 'tool');
  if (!tools.length) {
    if (entries.some((entry) => entry.kind === 'reasoning')) return thoughtLabel(thoughtDuration(entries));
    return 'Notifications';
  }
  const running = tools.filter((entry) => entry.running === true || entry.preparing === true);
  const done = tools.filter((entry) => entry.running !== true && entry.preparing !== true);
  const parts = [...countByCategory(running, 'running'), ...countByCategory(done, 'done')];
  return parts.slice(0, maxParts).join(', ') + (parts.length > maxParts ? '…' : '');
}

/**
 * What an open group's header should say, in priority order: the command that is
 * running now, the thought being written, then the command that ran last.
 * This signal belongs to the active group, including while collapsed;
 * completed groups use their work summary instead.
 */
export type GroupSignal = { kind: 'headline' | 'command' | 'summary'; text: string };

export function groupSignal(entries: readonly Entry[], headline: string): GroupSignal {
  const tools = entries.filter((entry) => entry.kind === 'tool');
  const running = [...tools].reverse().find((entry) => entry.running === true || entry.preparing === true);
  if (running) return { kind: 'command', text: running.command || running.tool || 'tool' };
  if (headline) return { kind: 'headline', text: headline };
  const last = tools[tools.length - 1];
  if (last) return { kind: 'command', text: last.command || last.tool || 'tool' };
  return { kind: 'summary', text: groupSummary(entries) };
}

export function turnDuration(turn: Turn): number | null {
  if (turn.startedAt === null || turn.endedAt === null) return null;
  return Math.max(0, turn.endedAt - turn.startedAt);
}

/** 784.4k, 126.9k: a token count a reader can size at a glance. */
export function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(Math.round(value));
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(1, Math.round(ms / 100)) / 10}s`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${Math.round(seconds - minutes * 60)}s`;
}

export function isShellTool(entry: Entry): boolean {
  const tool = entry.tool || entry.command?.split(/\s/, 1)[0] || '';
  return /(?:^|[/:])(?:execute_command|exec_command|shell|bash|powershell|pwsh|cmd|cd|Get-[a-z]+|Select-[a-z]+|node|npm|npx|git|rg)$/i.test(
    tool,
  );
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
