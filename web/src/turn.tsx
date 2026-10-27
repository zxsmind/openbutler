import { useEffect, useId, useState } from 'react';
import { toolEntryCommand } from '../../src/tool-display.js';
import { Markdown } from './markdown.js';
import type { Entry, RuntimeInfo } from './types.js';
import { ToolOutput } from './components/tool-output.js';
import { ReasoningText } from './components/reasoning-text.js';
import { ScrollArea } from './components/scroll-area.js';
import { Collapsible } from './components/collapsible.js';
import { Icon } from './components/ui.js';
import { Feedback } from './components/feedback.js';
import { MessageAttachments } from './components/message-attachments.js';
import {
  activeGroupIndex,
  formatDuration,
  formatTokens,
  groupTimeline,
  groupSummary,
  groupSignal,
  isShellTool,
  reasoningTitle,
  stepLabel,
  thoughtHeadline,
  thoughtLabel,
  turnDuration,
  turnContents,
  type GroupSignal,
  type Turn,
} from './turns.js';

/** How long a thought headline stays up before a newer signal may replace it. */
const HEADLINE_HOLD_MS = 1_200;
/** How long one headline is readable before the next sentence may take over. */
const HEADLINE_ROTATE_MS = 7_000;

/**
 * A compaction is a change to what the model can see, so it gets its own row:
 * running, finished, or interrupted, with the sizes it moved between.
 */
function CompactionRow({ entry }: { entry: Entry }) {
  const status = entry.status ?? 'running';
  const label = status === 'done' ? 'Context compacted' : status === 'failed' ? 'Compaction interrupted' : 'Compacting context…';
  const sizes =
    entry.beforeTokens !== undefined && entry.afterTokens !== undefined
      ? `${formatTokens(entry.beforeTokens)} → ${formatTokens(entry.afterTokens)}`
      : entry.beforeTokens !== undefined
        ? `${formatTokens(entry.beforeTokens)} → …`
        : null;
  return (
    <div className={`compaction compaction--${status}`} title={sizes ?? undefined}>
      <span className="compaction__icon">
        <Icon name="minimize-2" size={14} />
      </span>
      <span className="compaction__label">{label}</span>
      {sizes ? <span className="compaction__sizes">{sizes}</span> : null}
    </div>
  );
}

function failed(entry: Entry): boolean {
  const text = `${entry.result ?? ''}`.toLowerCase();
  return /^error|failed|not permitted|refused|denied/.test(text) || text.includes('exit 1');
}

function isBrowser(entry: Entry): boolean {
  const tool = entry.tool || entry.command?.split(/\s/, 1)[0] || '';
  return /(?:^|[/_-])(?:browser|playwright|chrome|cua)(?:[/_-]|$)/i.test(tool);
}

function EntryNotice({ entry }: { entry: Entry }) {
  const tone = entry.tone ?? (entry.kind === 'error' ? 'error' : 'info');
  return entry.text ? (
    <Feedback tone={tone === 'warn' ? 'warning' : tone} announce={false}>
      {entry.text}
    </Feedback>
  ) : null;
}

function StepRow({ entry, live }: { entry: Entry; live: boolean }) {
  // A thinking block streams its text and only gets its duration once the block
  // ends. It stays open while it is being written and folds into "Thought for
  // Xs" the moment the duration lands; a block the reader opened stays open.
  const thinking = live && entry.kind === 'reasoning' && entry.durationMs === undefined;
  const [open, setOpen] = useState(thinking);
  const [automatic, setAutomatic] = useState(thinking);
  const [wasThinking, setWasThinking] = useState(thinking);
  if (wasThinking !== thinking) {
    setWasThinking(thinking);
    if (thinking) {
      setAutomatic(true);
      setOpen(true);
    } else if (automatic) {
      setAutomatic(false);
      setOpen(false);
    }
  }
  const toggle = () => {
    setAutomatic(false);
    setOpen((value) => !value);
  };
  const { verb } = stepLabel(entry);
  const label = entry.kind === 'reasoning' ? thoughtLabel(entry.durationMs) : toolEntryCommand(entry);
  const running = entry.running === true || entry.preparing === true;
  const bad = !running && failed(entry);
  const hasDetail = entry.kind === 'tool' || Boolean(entry.text);

  return (
    <div className={`step${open ? ' open' : ''}`}>
      <button type="button" className="step-line" data-scroll-preserve onClick={toggle} aria-expanded={open}>
        {entry.kind !== 'reasoning' ? (
          <span className={`step-status${running ? ' busy' : bad ? ' failed' : ''}`}>
            <Icon name={isBrowser(entry) ? 'globe' : /^(read|file_read)$/i.test(verb) ? 'folder' : 'square-terminal'} />
          </span>
        ) : null}
        <span className="step-caption" title={label}>
          <span className="step-command">
            {entry.kind === 'tool' && isShellTool(entry) ? (running ? 'Running command' : 'Command ran') : label}
          </span>
        </span>
        {hasDetail ? (
          <span className={`step-chevron${open ? ' expanded' : ''}`}>
            <Icon name="chevron-down" />
          </span>
        ) : null}
      </button>
      <Collapsible open={open}>
        <div className="step-body">
          {entry.kind === 'tool' ? (
            <ToolOutput entry={entry} running={running} />
          ) : (
            <ReasoningText text={entry.text ?? ''} follow={thinking} reveal={entry.streamReveal} />
          )}
        </div>
      </Collapsible>
    </div>
  );
}

function StepGroup({ entries, live, active, titles }: { entries: Entry[]; live: boolean; active: boolean; titles: boolean }) {
  const [open, setOpen] = useState(active);
  // Whether the current `open` came from being the active group rather than a
  // click, so only an automatic opening is folded again when the next group
  // starts. A group the reader opened stays open.
  const [automatic, setAutomatic] = useState(active);
  const [wasActive, setWasActive] = useState(active);
  if (wasActive !== active) {
    setWasActive(active);
    if (active) {
      setAutomatic(true);
      setOpen(true);
    } else if (automatic) {
      setAutomatic(false);
      setOpen(false);
    }
  }
  const toggle = () => {
    setAutomatic(false);
    setOpen((value) => !value);
  };
  const [shown, setShown] = useState<{ text: string; kind: GroupSignal['kind']; at: number }>({ text: '', kind: 'summary', at: 0 });
  const [, setTick] = useState(0);
  const hasTools = entries.some((entry) => entry.kind === 'tool');
  const hasReasoning = entries.some((entry) => entry.kind === 'reasoning');
  const running = entries.some((entry) => entry.running || entry.preparing);
  const browser = entries.some(isBrowser);
  const summary = groupSummary(entries);
  const fullSummary = groupSummary(entries, Number.MAX_SAFE_INTEGER);
  // Rank complete sentences only within the newest streaming thought. An older
  // unstamped block must not supply the headline for work that has moved on.
  const streaming = active
    ? [...entries].reverse().find((entry) => entry.kind === 'reasoning' && entry.durationMs === undefined)
    : undefined;
  // Summary-style providers open a thought with a bold title line; headline it
  // for them, and keep the ranked sentence for every other provider.
  const streamingText = streaming?.text ?? '';
  const headline = !streamingText
    ? ''
    : titles
      ? (reasoningTitle(streamingText) ?? thoughtHeadline(streamingText))
      : thoughtHeadline(streamingText);
  // Activity owns the header; expanding/collapsing only controls the body.
  // Finished groups show a summary even when the reader opens them again.
  const desired = active ? groupSignal(entries, headline) : { kind: 'summary' as const, text: summary };
  // A headline is replaced by a command at once (it is what is happening), but
  // by another headline only once the reader has had time to read this one.
  const hold = desired.kind === 'headline' ? HEADLINE_ROTATE_MS : HEADLINE_HOLD_MS;
  const holding = shown.kind === 'headline' && shown.text !== desired.text && Date.now() - shown.at < hold;
  if (desired.text && desired.text !== shown.text && !holding) setShown({ ...desired, at: Date.now() });
  useEffect(() => {
    if (!holding) return;
    const timer = setTimeout(() => setTick((value) => value + 1), Math.max(0, hold - (Date.now() - shown.at)));
    return () => clearTimeout(timer);
  }, [holding, hold, shown.at]);
  const label = active ? shown.text || summary : summary;
  return (
    <div className={`tool-group${open ? ' open' : ''}${live && running ? ' running' : ''}`}>
      <button type="button" className="turn-toggle" data-scroll-preserve aria-expanded={open} onClick={toggle}>
        {hasTools || !hasReasoning ? (
          <span className="group-icon">
            <Icon name={browser ? 'panels-top-left' : hasTools ? 'square-terminal' : 'info'} />
          </span>
        ) : null}
        <span
          className={`group-label${active && shown.kind === 'headline' ? ' snippet' : ''}`}
          title={label === summary ? fullSummary : label}
        >
          {label}
        </span>
        <span className={`step-chevron${open ? ' expanded' : ''}`}>
          <Icon name="chevron-down" />
        </span>
      </button>
      <Collapsible open={open}>
        <ScrollArea className="steps" role="region" aria-label="Step details" tabIndex={0} follow={live}>
          {entries.map((entry, index) =>
            entry.kind === 'tool' || entry.kind === 'reasoning' ? (
              <StepRow key={entry.eventId || index} entry={entry} live={live} />
            ) : (
              <EntryNotice key={entry.eventId || index} entry={entry} />
            ),
          )}
        </ScrollArea>
      </Collapsible>
    </div>
  );
}
export function TurnView({ turn, live, sessionId, runtime }: { turn: Turn; live: boolean; sessionId: string; runtime?: RuntimeInfo }) {
  const [expanded, setExpanded] = useState<boolean | null>(null);
  const detailsId = useId();
  const groups = groupTimeline(turn);
  const { details, answer } = turnContents(turn);
  const firstWork = details.findIndex((group) => group.kind !== 'message' || group.entry.kind !== 'user');
  const leadingUsers = details.slice(0, firstWork < 0 ? details.length : firstWork);
  const workDetails = details.slice(leadingUsers.length);
  // A reader's explicit choice takes precedence over the automatic live/finished state.
  const open = expanded ?? (live || workDetails.some((group) => group.kind === 'message' && group.entry.kind === 'user'));
  const duration = live && turn.startedAt !== null ? Math.max(0, Date.now() - turn.startedAt) : turnDuration(turn);
  const outcome = turn.user?.turnOutcome;
  const label = live ? 'Working for' : outcome === 'cancelled' ? 'Stopped after' : outcome === 'failed' ? 'Failed after' : 'Took';
  // The open group belongs to the run that is still going: once the work stops,
  // the last group folds like every other finished group.
  const activeGroup = activeGroupIndex(groups, live);
  return (
    <section className={`turn${live ? ' live' : ''}`}>
      {turn.user ? (
        <div className="ask">
          <div className="prose">
            <MessageAttachments entry={turn.user} sessionId={sessionId} />
            {(turn.user.text ?? '').trimEnd()}
          </div>
        </div>
      ) : null}
      {leadingUsers.map((group, index) => {
        const entry = group.kind === 'message' ? group.entry : null;
        return entry ? (
          <div className="ask" key={entry.eventId || index}>
            <div className="prose">
              <MessageAttachments entry={entry} sessionId={sessionId} />
              {(entry.text ?? '').trimEnd()}
            </div>
          </div>
        ) : null;
      })}
      {workDetails.length > 0 ? (
        <button
          type="button"
          className="turn-toggle turn-work-duration"
          data-scroll-preserve
          aria-expanded={open}
          aria-controls={detailsId}
          onClick={() => setExpanded(!open)}
        >
          <span>{duration === null ? 'Work details' : `${label} ${formatDuration(duration)}`}</span>
          <span className={`step-chevron${open ? ' expanded' : ''}`}>
            <Icon name="chevron-down" />
          </span>
        </button>
      ) : null}
      <Collapsible id={detailsId} open={open}>
        {workDetails.map((group, index) => {
          if (group.kind === 'steps')
            return (
              <StepGroup
                key={index}
                entries={group.entries}
                live={live}
                active={index + leadingUsers.length === activeGroup}
                titles={runtime?.reasoningTitles === true}
              />
            );
          if (group.kind === 'compaction') return <CompactionRow key={`compaction-${index}`} entry={group.entry} />;
          const entry = group.entry;
          // A message the owner sent into a running turn is still their words, not
          // a notice: it renders like the opening ask, in its place in the timeline.
          if (entry.kind === 'user')
            return (
              <div className="ask" key={entry.eventId || index}>
                <div className="prose">
                  <MessageAttachments entry={entry} sessionId={sessionId} />
                  {(entry.text ?? '').trimEnd()}
                </div>
              </div>
            );
          if (entry.kind === 'assistant')
            return entry.text?.trim() ? (
              <div className="answer" key={entry.eventId || index}>
                <div className="body">
                  <Markdown text={entry.text.trimEnd()} reveal={entry.streamReveal} />
                </div>
              </div>
            ) : null;
          return <EntryNotice key={entry.eventId || index} entry={entry} />;
        })}
      </Collapsible>
      {answer ? (
        <div className="answer">
          <div className="body">
            <Markdown text={answer.text!.trimEnd()} reveal={answer.streamReveal} />
          </div>
        </div>
      ) : null}
    </section>
  );
}
