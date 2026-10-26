import { isShellTool } from '../turns.js';
import { ScrollArea } from './scroll-area.js';
import type { Entry } from '../types.js';
import { StreamText } from './stream-text.js';
import { toolEntryCommand, toolEntryDetails } from '../../../src/tool-display.js';

export function ToolOutput({ entry, running }: { entry: Entry; running: boolean }) {
  const shell = isShellTool(entry);
  const raw = toolEntryCommand(entry).trim();
  const space = raw.indexOf(' ');
  const verb = space === -1 ? raw : raw.slice(0, space);
  const target = space === -1 ? '' : raw.slice(space + 1);
  // A shell command is the whole line and reads better under a prompt glyph. A
  // file tool repeats its own verb ("Read <path>"), which is already the title,
  // so only the target is printed and the line stops being a second heading.
  const title = entry.toolTitle ?? (shell ? 'Shell' : verb || entry.tool || 'Tool');
  const command = entry.toolTitle !== undefined ? '' : shell ? raw : target;
  return (
    <ScrollArea className="tool-output" role="region" aria-label={`${title} output`} tabIndex={0} follow={running}>
      <div className="tool-output-title">{title}</div>
      {command ? (
        <pre className="tool-output-command">
          {shell ? <span className="shell-prompt">$ </span> : null}
          {command}
        </pre>
      ) : null}
      {entry.input ? (
        <>
          <div className="tool-output-title">Input</div>
          <pre className="tool-output-command">{toolEntryDetails(entry)}</pre>
          <div className="tool-output-title">Output</div>
        </>
      ) : null}
      <pre className="tool-output-result">
        {entry.result ? <StreamText text={entry.result} ranges={entry.streamReveal} /> : running ? 'Running…' : 'No output.'}
      </pre>
    </ScrollArea>
  );
}
