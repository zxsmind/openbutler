import type { ReactNode } from 'react';
import './feedback.css';

export type FeedbackTone = 'neutral' | 'info' | 'success' | 'warning' | 'error' | 'loading';

/** Text-only feedback. The no-card/no-icon design contract lives in tests/web/feedback.test.ts. */
export function Feedback({
  tone = 'neutral',
  layout = 'inline',
  title,
  children,
  action,
  onDismiss,
  announce = true,
  className = '',
}: {
  tone?: FeedbackTone;
  layout?: 'inline' | 'compact' | 'state';
  title?: string;
  children?: ReactNode;
  action?: { label: string; onClick: () => void; disabled?: boolean };
  onDismiss?: () => void;
  announce?: boolean;
  className?: string;
}) {
  return (
    <div
      className={`feedback feedback--${tone} feedback--${layout}${onDismiss ? ' feedback--dismissible' : ''} ${className}`.trim()}
      role={announce ? (tone === 'error' ? 'alert' : 'status') : undefined}
    >
      <div className="feedback__content">
        {title ? <div className="feedback__title">{title}</div> : null}
        {children ? <div className="feedback__description">{children}</div> : null}
        {action ? (
          <div className="feedback__actions">
            <button type="button" className="feedback__action" onClick={action.onClick} disabled={action.disabled}>
              {action.label}
            </button>
          </div>
        ) : null}
      </div>
      {onDismiss ? (
        <button
          type="button"
          aria-label={tone === 'error' ? 'Dismiss error' : 'Dismiss notification'}
          className="feedback__dismiss"
          onClick={onDismiss}
        >
          ×
        </button>
      ) : null}
    </div>
  );
}
