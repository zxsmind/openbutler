/**
 * A stored transcript boundary: a settings change the backend announced or the
 * day a message opened. The text arrives with the entry, so every client draws
 * the same line without deciding anything.
 */
export function ChatDivider({ text }: { text: string }) {
  return (
    <div className="chat-divider" role="separator" data-divider="">
      <span>{text}</span>
    </div>
  );
}
