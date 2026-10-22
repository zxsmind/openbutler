import { useState } from 'react';
import type { SessionPayload } from '../types.js';
import { Button, Icon, IconButton } from './ui.js';
import { Dropdown } from './selection/dropdown.js';
import { ComposerRail } from './composer-rail.js';
import './message-queue.css';

export function MessageQueue({
  messages = [],
  disabled,
  onAction,
}: {
  messages: SessionPayload['queuedMessages'];
  disabled: boolean;
  onAction: (id: string, action: 'steer' | 'remove') => Promise<void>;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const perform = async (operation: () => Promise<unknown>) => {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      await operation();
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : String(problem));
    } finally {
      setPending(false);
    }
  };
  if (!messages.length && !error) return null;
  return (
    <ComposerRail aria-label="Kuyruktaki mesajlar" aria-busy={pending}>
      {error ? (
        <div className="message-queue__error" role="alert">
          <span>{error}</span>
          <IconButton icon="x" label="Dismiss error" onClick={() => setError(null)} />
        </div>
      ) : null}
      {messages.length ? (
        <ol className="message-queue__list">
          {messages.map((message, index) => {
            const inactive = disabled || pending || !message.id || !message.editable;
            const text = message.text || `${message.imageCount} image${message.imageCount === 1 ? '' : 's'}`;
            return (
              <li className="composer-rail__row message-queue__row" key={message.id ?? index}>
                <Icon name="list-end" size={13} className="message-queue__marker" />
                <span className="message-queue__text" title={text}>
                  {text}
                </span>
                {message.text && message.imageCount ? (
                  <span className="message-queue__images">
                    <Icon name="image" size={12} />
                    {message.imageCount}
                  </span>
                ) : null}
                <Button
                  className="message-queue__steer"
                  icon="corner-down-right"
                  disabled={inactive}
                  title="Steer the running task at its next step"
                  onClick={() => void perform(() => onAction(message.id!, 'steer'))}
                >
                  Steer
                </Button>
                <IconButton
                  icon="trash-2"
                  label="Kuyruktan sil"
                  disabled={inactive}
                  onClick={() => void perform(() => onAction(message.id!, 'remove'))}
                />
                <Dropdown
                  ariaLabel="Queued message options"
                  placement="top"
                  align="end"
                  items={[
                    {
                      id: 'copy',
                      label: 'Copy message',
                      leading: <Icon name="copy" size={14} />,
                      onSelect: () => perform(() => navigator.clipboard.writeText(text)),
                    },
                  ]}
                  renderTrigger={({ ref, toggle, open }) => (
                    <button
                      ref={ref}
                      type="button"
                      className="button button-ghost icon-button"
                      aria-label="Queued message options"
                      aria-haspopup="menu"
                      aria-expanded={open}
                      onClick={toggle}
                      disabled={pending}
                    >
                      <Icon name="ellipsis" size={14} />
                    </button>
                  )}
                />
              </li>
            );
          })}
        </ol>
      ) : null}
    </ComposerRail>
  );
}
