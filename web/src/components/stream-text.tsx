import { createContext, Fragment, useLayoutEffect, useRef, type ReactNode } from 'react';
import { revealParts, streamRevealDuration, STREAM_REVEAL_MS, type StreamRange } from '../stream-reveal.js';

export const StreamRanges = createContext<readonly StreamRange[]>([]);

/** Native opacity animation; React owns every node, the browser owns the frames. */
export function StreamChunk({ at, children }: { at: number; children: ReactNode }) {
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    const elapsed = performance.now() - at;
    const duration = streamRevealDuration();
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    if (!element || !element.animate || media.matches || elapsed >= duration || document.visibilityState === 'hidden') return;
    const animation = element.animate([{ opacity: 0 }, { opacity: 1 }], {
      duration,
      easing: duration > STREAM_REVEAL_MS ? 'cubic-bezier(0.25, 0.46, 0.45, 0.94)' : 'cubic-bezier(0.215, 0.61, 0.355, 1)',
    });
    animation.currentTime = Math.max(0, elapsed);
    const finish = () => animation.finish();
    media.addEventListener('change', finish);
    document.addEventListener('visibilitychange', finish);
    return () => {
      media.removeEventListener('change', finish);
      document.removeEventListener('visibilitychange', finish);
      animation.cancel();
    };
  }, [at]);
  return <span ref={ref}>{children}</span>;
}

export function StreamText({ text, ranges = [], offset = 0 }: { text: string; ranges?: readonly StreamRange[]; offset?: number }) {
  if (!ranges.length) return text;
  const offsets = Array.from({ length: text.length }, (_, i) => offset + i);
  return revealParts(text, offsets, ranges).map((part) =>
    part.at === undefined ? (
      <Fragment key={part.offset}>{part.text}</Fragment>
    ) : (
      <StreamChunk key={part.offset} at={part.at}>
        {part.text}
      </StreamChunk>
    ),
  );
}
