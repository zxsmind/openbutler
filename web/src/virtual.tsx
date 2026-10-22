import { useCallback, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { bindReaderGestures, createScrollFollower, type ScrollFollower } from './scroll-follow.js';

interface VirtualListProps<T> {
  items: T[];
  getKey: (item: T) => string;
  estimate?: number;
  overscan?: number;
  render: (item: T, absoluteIndex: number) => ReactNode;
  header?: ReactNode;
  footer?: ReactNode;
  onLoadOlder?: () => void;
  hasOlder: boolean;
  loadingOlder?: boolean;
  /** Changes only when the caller explicitly requests the newest content. */
  followRequest?: number;
}

function MeasuredRow({
  index,
  top,
  measure,
  children,
}: {
  index: string;
  top: number;
  measure: (index: string, node: HTMLDivElement | null) => void;
  children: ReactNode;
}) {
  const row = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const node = row.current;
    if (!node) return;
    // ResizeObserver runs before paint. Commit the spacer and subsequent row
    // offsets in that same frame instead of displaying yesterday's geometry.
    const observer = new ResizeObserver(() => flushSync(() => measure(index, node)));
    observer.observe(node);
    measure(index, node);
    return () => observer.disconnect();
  }, [index, measure]);
  return (
    <div ref={row} className="row" style={{ transform: `translateY(${top}px)` }}>
      {children}
    </div>
  );
}

/**
 * Rows live in a tall spacer and only the visible slice is mounted, so a long
 * transcript costs a few dozen DOM nodes instead of thousands. Heights are
 * measured before paint and cached, which keeps scroll geometry exact without
 * laying out off-screen rows.
 */
export function VirtualList<T>({
  items,
  getKey,
  estimate = 96,
  overscan = 6,
  render,
  header,
  footer,
  onLoadOlder,
  hasOlder,
  loadingOlder = false,
  followRequest,
}: VirtualListProps<T>) {
  const scroller = useRef<HTMLDivElement | null>(null);
  const heights = useRef(new Map<string, number>());
  const measurementRevision = useRef(0);
  const initializing = useRef(true);
  const [revision, setTick] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(800);
  const follower = useRef<ScrollFollower | null>(null);
  const layout = useRef<{ keys: string[]; offsets: number[]; footer: ReactNode } | null>(null);
  const anchor = useRef<{ key: string; offset: number } | null>(null);
  const followedRequest = useRef(followRequest);

  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const created = createScrollFollower(element);
    follower.current = created;
    const unbind = bindReaderGestures(element, created);
    return () => {
      unbind();
      created.destroy();
      follower.current = null;
    };
  }, []);

  const captureAnchor = useCallback(() => {
    const element = scroller.current;
    const previous = layout.current;
    if (!element || !previous) return;
    const rows = element.querySelector<HTMLElement>('.rows');
    const localTop = element.scrollTop - (rows ? rows.offsetTop - element.offsetTop : 0);
    const index = previous.keys.findIndex((_, i) => previous.offsets[i + 1] > localTop);
    anchor.current = index < 0 ? null : { key: previous.keys[index], offset: localTop - previous.offsets[index] };
  }, []);

  const measure = useCallback(
    (index: string, node: HTMLDivElement | null) => {
      if (!node) return;
      const height = node.getBoundingClientRect().height;
      if (height > 0 && heights.current.get(index) !== height) {
        // Read the current native scroll position before changing spacer geometry.
        // Keyboard/wheel scrolling may have moved it before its scroll event fires.
        captureAnchor();
        heights.current.set(index, height);
        measurementRevision.current += 1;
        setTick(measurementRevision.current);
      }
    },
    [captureAnchor],
  );

  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setViewport(element.clientHeight));
    observer.observe(element);
    setViewport(element.clientHeight);
    return () => observer.disconnect();
  }, []);

  const offsets: number[] = new Array(items.length + 1);
  offsets[0] = 0;
  for (let index = 0; index < items.length; index += 1) {
    offsets[index + 1] = offsets[index] + (heights.current.get(getKey(items[index])) ?? estimate);
  }
  const total = offsets[items.length];
  const firstKey = items.length ? getKey(items[0]) : null;
  // Mount the tail immediately. Walking from the first estimated rows to the
  // last ones would expose the entire history while measurements catch up.
  const windowTop = initializing.current ? Math.max(0, total - viewport) : scrollTop;

  let start = 0;
  while (start < items.length && offsets[start + 1] < windowTop - viewport) start += 1;
  start = Math.max(0, start - overscan);
  let end = start;
  while (end < items.length && offsets[end] < windowTop + viewport * 2) end += 1;
  end = Math.min(items.length, end + overscan);

  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const sentMessage = followedRequest.current !== followRequest;
    if (sentMessage) {
      followedRequest.current = followRequest;
      anchor.current = null;
      // The owner just acted: land on the new tail instead of gliding to it.
      // Easing here moved the typing dot under the reader's eyes.
      follower.current?.resume({ immediate: true });
    }
    if (initializing.current) {
      // Initial history placement is not live growth. Keep it immediate until
      // the rendered rows and viewport have committed their real dimensions.
      follower.current?.follow({ immediate: true });
      setScrollTop(element.scrollTop);
      if (items.length > 0 && revision === measurementRevision.current && viewport === element.clientHeight) {
        initializing.current = false;
      }
    } else if (follower.current?.pinned !== false) {
      const previous = layout.current;
      // A footer that appears or disappears changes the content height in one
      // step (the typing dot is 46px tall); easing through it bobbed the dot.
      const footerChanged = previous !== null && footer !== previous.footer;
      // Streamed growth follows the same eased path as nested output. Adding
      // each measured height directly to scrollTop bypassed that motion.
      follower.current?.follow(footerChanged ? { immediate: true } : undefined);
    } else {
      if (!anchor.current) captureAnchor();
      if (anchor.current) {
        const index = items.findIndex((item) => getKey(item) === anchor.current?.key);
        const rows = element.querySelector<HTMLElement>('.rows');
        if (index >= 0 && rows) element.scrollTop = rows.offsetTop - element.offsetTop + offsets[index] + anchor.current.offset;
      }
    }
    layout.current = { keys: items.map(getKey), offsets, footer };
    anchor.current = null;
  }, [total, viewport, firstKey, items.length, followRequest, revision, footer]);

  const handleScroll = (event: React.UIEvent<HTMLDivElement>) => {
    const element = scroller.current;
    if (!element) return;
    // React listens for scroll at the root, so a scroll inside a nested region
    // (a step list, a tool output) arrives here too. Only the transcript itself
    // may decide whether the transcript is pinned.
    if (event.target !== element) return;
    // Following the stream moves the transcript every frame; re-rendering the
    // list for every pixel of that drift is what made a phone fall behind, so a
    // scroll only counts once it is far enough to change which rows are shown.
    setScrollTop((previous) => (Math.abs(element.scrollTop - previous) >= 8 ? element.scrollTop : previous));
    // Reader gestures release the follow; returning to the bottom resumes it.
    // Layout-driven scroll events must not cancel automatic tracking.
    follower.current?.track();
    anchor.current = null;
    if (element.scrollTop < 240 && hasOlder && onLoadOlder && !loadingOlder) onLoadOlder();
  };

  return (
    <div className="scroller" data-scroll-viewport tabIndex={0} aria-label="Conversation" ref={scroller} onScroll={handleScroll}>
      {header}
      <div className="rows" style={{ height: total }}>
        {items.slice(start, end).map((item, offset) => {
          const index = start + offset;
          const key = getKey(item);
          return (
            <MeasuredRow key={key} index={key} top={offsets[index]} measure={measure}>
              {render(item, index)}
            </MeasuredRow>
          );
        })}
      </div>
      {footer}
    </div>
  );
}
