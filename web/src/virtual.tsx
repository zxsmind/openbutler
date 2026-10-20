import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';

interface VirtualListProps<T> {
  items: T[];
  getKey: (item: T) => string;
  estimate?: number;
  overscan?: number;
  render: (item: T, absoluteIndex: number) => ReactNode;
  header?: ReactNode;
  onLoadOlder?: () => void;
  hasOlder: boolean;
  loadingOlder?: boolean;
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
    const observer = new ResizeObserver(() => measure(index, node));
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
 * measured after paint and cached, which keeps scroll geometry exact without
 * laying out off-screen rows.
 */
export function VirtualList<T>({
  items,
  getKey,
  estimate = 96,
  overscan = 6,
  render,
  header,
  onLoadOlder,
  hasOlder,
  loadingOlder = false,
}: VirtualListProps<T>) {
  const scroller = useRef<HTMLDivElement | null>(null);
  const heights = useRef(new Map<string, number>());
  const [, setTick] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(800);
  const stickToBottom = useRef(true);
  const anchor = useRef<{ key: string; offset: number } | null>(null);

  const measure = useCallback((index: string, node: HTMLDivElement | null) => {
    if (!node) return;
    const height = node.offsetHeight;
    if (height > 0 && heights.current.get(index) !== height) {
      heights.current.set(index, height);
      setTick((value) => value + 1);
    }
  }, []);

  useEffect(() => {
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

  let start = 0;
  while (start < items.length && offsets[start + 1] < scrollTop - viewport) start += 1;
  start = Math.max(0, start - overscan);
  let end = start;
  while (end < items.length && offsets[end] < scrollTop + viewport * 2) end += 1;
  end = Math.min(items.length, end + overscan);

  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element) return;
    if (stickToBottom.current) {
      element.scrollTop = element.scrollHeight;
    } else if (anchor.current) {
      const index = items.findIndex((item) => getKey(item) === anchor.current?.key);
      const rows = element.querySelector<HTMLElement>('.rows');
      if (index >= 0 && rows) element.scrollTop = rows.offsetTop - element.offsetTop + offsets[index] + anchor.current.offset;
    }
  });

  const handleScroll = () => {
    const element = scroller.current;
    if (!element) return;
    setScrollTop(element.scrollTop);
    stickToBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 48;
    const rows = element.querySelector<HTMLElement>('.rows');
    const localTop = element.scrollTop - (rows ? rows.offsetTop - element.offsetTop : 0);
    const index = items.findIndex((_, i) => offsets[i + 1] > localTop);
    if (index >= 0) anchor.current = { key: getKey(items[index]), offset: localTop - offsets[index] };
    if (element.scrollTop < 240 && hasOlder && onLoadOlder && !loadingOlder) onLoadOlder();
  };

  return (
    <div className="scroller" tabIndex={0} aria-label="Conversation" ref={scroller} onScroll={handleScroll}>
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
    </div>
  );
}
