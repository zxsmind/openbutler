import { useState } from 'react';
import { Markdown } from './markdown.js';
import type { Entry } from './types.js';
import { ToolOutput, isShellTool } from './components/tool-output.js';
import { Icon } from './components/ui.js';
import { formatDuration, stepLabel, turnDuration, type Turn } from './turns.js';

function failed(entry: Entry): boolean {
  const text = `${entry.result ?? ''}`.toLowerCase();
  return /^error|failed|not permitted|refused|denied/.test(text) || text.includes('exit 1');
}

function isBrowser(entry: Entry): boolean {
  const tool = entry.tool || entry.command?.split(/\s/, 1)[0] || '';
  return /(?:^|[/_-])(?:browser|playwright|chrome|cua)(?:[/_-]|$)/i.test(tool);
}

function StepRow({ entry }: { entry: Entry }) {
  const [open, setOpen] = useState(false);
  const { verb } = stepLabel(entry);
  const label = entry.kind === 'reasoning' ? 'Thought' : entry.command || entry.tool || 'tool';
  const running = entry.running === true || entry.preparing === true;
  const bad = !running && failed(entry);
  const duration = entry.durationMs;
  const hasDetail = entry.kind === 'tool' || Boolean(entry.text);

  return (
    <div className={`step${open ? ' open' : ''}`}>
      <button type="button" className="step-line" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
        <span className={`step-status${running ? ' busy' : bad ? ' failed' : ''}`}>
          <Icon
            name={
              entry.kind === 'reasoning' ? 'spark' : isBrowser(entry) ? 'globe' : /^(read|file_read)$/i.test(verb) ? 'folder' : 'terminal'
            }
          />
        </span>
        <span className="step-caption" title={`${label}${duration !== undefined ? ` · ${formatDuration(duration)}` : ''}`}>
          <span className="step-command">
            {open && entry.kind === 'tool' && isShellTool(entry) ? (running ? 'Komut çalıştırılıyor' : 'Komut çalıştırıldı') : label}
          </span>
          {entry.kind === 'reasoning' && duration !== undefined ? <span className="step-time">{formatDuration(duration)}</span> : null}
        </span>
        {hasDetail ? (
          <span className={`step-chevron${open ? ' expanded' : ''}`}>
            <Icon name="chevron" />
          </span>
        ) : null}
      </button>
      {open ? (
        <div className="step-body">
          {entry.kind === 'tool' ? <ToolOutput entry={entry} running={running} /> : <div className="prose dim">{entry.text}</div>}
        </div>
      ) : null}
    </div>
  );
}

function StepGroup({ entries, live }: { entries: Entry[]; live: boolean }) {
  const [open, setOpen] = useState(false);
  const hasTools = entries.some((entry) => entry.kind === 'tool');
  const running = entries.some((entry) => entry.running || entry.preparing);
  const browser = entries.some(isBrowser);
  const commands = entries.some((entry) => entry.kind === 'tool' && !isBrowser(entry));
  return (
    <div className={`tool-group${open ? ' open' : ''}${live && running ? ' running' : ''}`}>
      <button type="button" className="turn-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="group-icon">
          <Icon name={browser ? 'browser' : hasTools ? 'terminal' : 'spark'} />
        </span>
        <span>
          {live && running
            ? browser
              ? 'Tarayıcı kullanılıyor'
              : 'Komut çalıştırılıyor'
            : browser
              ? commands
                ? 'Tarayıcı kullanıldı, komutlar çalıştırıldı'
                : 'Tarayıcı kullanıldı'
              : hasTools
                ? 'Komutlar çalıştırıldı'
                : 'Düşünüldü'}
        </span>
        <span className={`step-chevron${open ? ' expanded' : ''}`}>
          <Icon name="chevron" />
        </span>
      </button>
      {open ? (
        <div className="steps">
          {entries.map((entry, index) => (
            <StepRow key={entry.eventId || index} entry={entry} />
          ))}
        </div>
      ) : null}
    </div>
  );
}
export function TurnView({ turn, live }: { turn: Turn; live: boolean }) {
  const duration = live && turn.startedAt !== null ? Math.max(0, Date.now() - turn.startedAt) : turnDuration(turn);
  const groups: Array<{ kind: 'steps'; entries: Entry[] } | { kind: 'message'; entry: Entry }> = [];
  for (const entry of turn.timeline) {
    if (entry.kind === 'tool' || entry.kind === 'reasoning') {
      const previous = groups[groups.length - 1];
      if (previous?.kind === 'steps') previous.entries.push(entry);
      else groups.push({ kind: 'steps', entries: [entry] });
    } else groups.push({ kind: 'message', entry });
  }
  return (
    <section className={`turn${live ? ' live' : ''}`}>
      {turn.user ? (
        <div className="ask">
          <div className="prose">
            {(turn.user.text ?? '').trimEnd()}
            {turn.user.imageCount ? <span className="message-attachments">{turn.user.imageCount} görsel eklendi</span> : null}
          </div>
        </div>
      ) : null}
      {duration !== null && turn.steps.length > 0 ? (
        <div className="turn-work-duration">
          {formatDuration(duration).replace('m ', 'd ').replace(/s$/, 'sn')} {live ? 'süredir çalışıyor' : 'çalıştı'}
        </div>
      ) : null}
      {groups.map((group, index) => {
        if (group.kind === 'steps') return <StepGroup key={index} entries={group.entries} live={live} />;
        const entry = group.entry;
        if (entry.kind === 'assistant')
          return entry.text?.trim() ? (
            <div className="answer" key={entry.eventId || index}>
              <div className="body">
                <Markdown text={entry.text.trimEnd()} />
              </div>
            </div>
          ) : null;
        return entry.text ? (
          <div className={`notice ${entry.tone ?? 'info'}`} key={entry.eventId || index}>
            {entry.text}
          </div>
        ) : null;
      })}
    </section>
  );
}
