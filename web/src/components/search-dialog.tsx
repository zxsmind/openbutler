import { useEffect, useRef, useState } from 'react';
import type { SessionInfo } from '../types.js';
import { Icon, IconButton } from './ui.js';
import { Feedback } from './feedback.js';
export function SearchDialog({
  sessions,
  disabled,
  onSelect,
  onClose,
}: {
  sessions: SessionInfo[];
  disabled: boolean;
  onSelect: (id: string) => void;
  onClose: () => void;
}) {
  const [search, setSearch] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    input.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }
      if (event.key === 'Tab') {
        const items = [...(root.current?.querySelectorAll<HTMLElement>('input, button:not(:disabled)') || [])];
        const first = items[0],
          last = items[items.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      previous?.focus();
    };
  }, [onClose]);
  const results = sessions.filter((session) =>
    `${session.title} ${session.preview || ''}`.toLocaleLowerCase('tr').includes(search.toLocaleLowerCase('tr')),
  );
  return (
    <div
      className="search-overlay"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div ref={root} className="search-dialog" role="dialog" aria-modal="true" aria-label="Sohbetlerde ara">
        <div className="search-field">
          <Icon name="search" />
          <input
            ref={input}
            aria-label="Sohbetlerde ara"
            placeholder="Sohbetlerde ara"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <IconButton icon="x" label="Close search" onClick={onClose} />
        </div>
        <div className="search-results">
          {results.slice(0, 50).map((session) => (
            <button className="search-result" key={session.id} disabled={disabled} onClick={() => onSelect(session.id)}>
              <Icon name="message-square" />
              <span>
                <strong>{session.title}</strong>
                <small>{session.preview}</small>
              </span>
            </button>
          ))}
          {!results.length ? (
            <Feedback layout="state" title="No chats found">
              Try a different search.
            </Feedback>
          ) : null}
        </div>
      </div>
    </div>
  );
}
