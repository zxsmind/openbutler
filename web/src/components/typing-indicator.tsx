import './typing-indicator.css';

/** Stable transcript footer: changing or virtualizing turns cannot restart its pulse. */
export function TypingIndicator() {
  return (
    <div className="typing-indicator" role="status" aria-label="The agent is typing">
      <span className="typing-indicator__dot" aria-hidden="true" />
    </div>
  );
}
