import { isShellTool } from '../turns.js';
import { ScrollArea } from './scroll-area.js';
import type { Entry } from '../types.js';

export function ToolOutput({ entry, running }: { entry: Entry; running: boolean }) {
  const shell = isShellTool(entry);
  const raw = (entry.command ?? '').trim();
  const space = raw.indexOf(' ');
  const verb = space === -1 ? raw : raw.slice(0, space);
  const target = space === -1 ? '' : raw.slice(space + 1);
  // A shell command is the whole line and reads better under a prompt glyph. A
  // file tool repeats its own verb ("Read <path>"), which is already the title,
  // so only the target is printed and the line stops being a second heading.
  const title = shell ? 'Shell' : verb || entry.tool || 'Tool';
  const command = shell ? raw : target;
  return (
    <ScrollArea className="tool-output" role="region" aria-label={`${title} output`} tabIndex={0} follow={running}>
      <div className="tool-output-title">{title}</div>
      {command ? (
        <pre className="tool-output-command">
          {shell ? <span className="shell-prompt">$ </span> : null}
          {command}
        </pre>
      ) : null}
      <pre className="tool-output-result">{entry.result || (running ? 'Running…' : 'No output.')}</pre>
    </ScrollArea>
  );
}
