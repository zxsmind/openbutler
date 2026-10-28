import { dividerLabel } from '../../../src/divider-label.js';

/**
 * The global transcript boundary: a settings statement, a compaction or a day
 * break. Day labels are derived from the stored moment at render time by the
 * shared rule, so the web and the terminal always read the same words.
 */
export function ChatDivider({ entry }: { entry: { at?: number | undefined; text?: string | undefined } }) {
  return (
    <div className="chat-divider" role="separator" data-divider="">
      <span>{dividerLabel(entry)}</span>
    </div>
  );
}
