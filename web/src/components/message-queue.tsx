import { useState } from 'react';
import type { SessionPayload } from '../types.js';
import { Button, Icon, IconButton } from './ui.js';
import { Dropdown } from './selection/dropdown.js';
import { ComposerRail } from './composer-rail.js';
import { Feedback } from './feedback.js';
import './message-queue.css';

type QueueFailure = { id: string | null; text: string };

export function MessageQueue({
  messages = [],
  busy,
  disabled,
  onAction,
}: {
  messages: SessionPayload['queuedMessages'];
  busy: boolean;
  disabled: boolean;
  onAction: (id: string, action: 'steer' | 'remove') => Promise<void>;
}) {
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<QueueFailure | null>(null);
  const perform = async (operation: () => Promise<unknown>, messageId: string | null) => {
    if (pending) return;
    setPending(true);
    setFailure(null);
    try {
      await operation();
    } catch (problem) {
      // The failure belongs to the row it came from; a message that disappeared
      // meanwhile falls back to the rail so the feedback is never orphaned.
      const exists = messageId !== null && messages.some((message) => message.id === messageId);
      setFailure({ id: exists ? messageId : null, text: problem instanceof Error ? problem.message : String(problem) });
    } finally {
      setPending(false);
    }
  };
  if (!messages.length && !failure) return null;
  return (
    <ComposerRail aria-label="Kuyruktaki mesajlar" aria-busy={pending}>
      {failure && failure.id === null ? (
        <Feedback tone="error" layout="compact" onDismiss={() => setFailure(null)}>
          {failure.text}
        </Feedback>
      ) : null}
      {messages.length ? (
        <ol className="message-queue__list">
          {messages.map((message, index) => {
            const inactive = disabled || pending || !message.id || !message.editable;
            const text = message.text || `${message.imageCount} image${message.imageCount === 1 ? '' : 's'}`;
            const rowFailure = failure !== null && failure.id === message.id ? failure.text : null;
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
                  disabled={inactive || !busy || message.steering}
                  title="Steer the running task at its next step"
                  onClick={() => void perform(() => onAction(message.id!, 'steer'), message.id ?? null)}
                >
                  {message.steering ? 'Steering…' : 'Steer'}
                </Button>
                <IconButton
                  icon="trash-2"
                  label="Kuyruktan sil"
                  disabled={inactive}
                  onClick={() => void perform(() => onAction(message.id!, 'remove'), message.id ?? null)}
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
                      onSelect: () => void perform(() => navigator.clipboard.writeText(text), message.id ?? null),
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
                {rowFailure ? (
                  <Feedback tone="error" layout="compact" className="message-queue__row-error" onDismiss={() => setFailure(null)}>
                    {rowFailure}
                  </Feedback>
                ) : null}
              </li>
            );
          })}
        </ol>
      ) : null}
    </ComposerRail>
  );
}
