import { ScrollArea } from './scroll-area.js';

export function ReasoningText({ text, follow = false }: { text: string; follow?: boolean }) {
  const paragraphs = text.split(/\r?\n(?:[\t ]*\r?\n)+/).filter((paragraph) => paragraph.trim());
  return (
    <ScrollArea className="prose dim reasoning-text" role="region" aria-label="Reasoning detail" tabIndex={0} follow={follow}>
      {paragraphs.map((paragraph, index) => (
        <p key={index}>{paragraph}</p>
      ))}
    </ScrollArea>
  );
}
