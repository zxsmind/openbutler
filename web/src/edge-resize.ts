import { useRef, useState, type PointerEvent } from 'react';

export interface EdgeResizeOptions {
  /** +1 grows while the pointer moves right; -1 grows while it moves left (right-side panels). */
  direction: 1 | -1;
  /** The element's committed width, frozen when a drag starts. */
  width: number;
  /** Viewport-aware cap, asked on every move so a window change mid-drag is respected. */
  getMaximum: () => number;
  /** Consumer policy: clamp the size, and optionally end the drag (a snap-close). */
  resolve: (width: number, distance: number, maximum: number) => { size: number; end?: boolean };
  /** Runs on a real drag start, after the button guard and before capture. */
  onStart?: () => void;
  onResize: (size: number, end: boolean) => void;
}

/**
 * The pointer mechanics every edge resizer shares: button guard, capture, a 3px
 * movement threshold so a click never resizes, and one resolve policy per
 * consumer. Width state, storage and keyboard handling stay with the consumer.
 */
export function useEdgeResize(options: EdgeResizeOptions) {
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ pointer: number; start: number; width: number; moved: boolean } | null>(null);

  const start = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || options.width <= 0) return;
    options.onStart?.();
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { pointer: event.pointerId, start: event.clientX, width: options.width, moved: false };
    setDragging(true);
  };
  const move = (event: PointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (!current || current.pointer !== event.pointerId) return;
    const raw = event.clientX - current.start;
    if (Math.abs(raw) > 3) current.moved = true;
    if (!current.moved) return;
    const resolved = options.resolve(current.width, raw * options.direction, options.getMaximum());
    if (resolved.end) {
      drag.current = null;
      setDragging(false);
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
      options.onResize(resolved.size, true);
      return;
    }
    options.onResize(resolved.size, false);
  };
  const finish = () => {
    drag.current = null;
    setDragging(false);
  };

  return { dragging, start, move, finish };
}
