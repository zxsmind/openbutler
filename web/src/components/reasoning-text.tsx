import { ScrollArea } from './scroll-area.js';
import { StreamText } from './stream-text.js';
import type { StreamRange } from '../stream-reveal.js';

export function ReasoningText({ text, follow = false, reveal }: { text: string; follow?: boolean; reveal?: readonly StreamRange[] }) {
  const paragraphs = [...text.matchAll(/[^\r\n]+(?:\r?\n(?![\t ]*\r?\n)[^\r\n]+)*/g)].filter((match) => match[0].trim());
  return (
    <ScrollArea className="prose dim reasoning-text" role="region" aria-label="Reasoning detail" tabIndex={0} follow={follow}>
      {paragraphs.map((paragraph) => (
        <p key={paragraph.index}>
          <StreamText text={paragraph[0]} ranges={reveal} offset={paragraph.index} />
        </p>
      ))}
    </ScrollArea>
  );
}
