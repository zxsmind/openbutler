import { useLayoutEffect, useRef, type HTMLAttributes } from 'react';
import { bindReaderGestures, createScrollFollower } from '../scroll-follow.js';

interface ScrollAreaProps extends HTMLAttributes<HTMLDivElement> {
  /**
   * Keep the newest content in view while it grows. The follow stops the moment
   * the reader scrolls away and resumes when they return to the bottom, so a
   * streaming block never fights a reader who is looking at the start of it.
   */
  follow?: boolean;
}

/** Fade only edges that have more content beyond them. */
export function ScrollArea({ className = '', children, follow = false, ...props }: ScrollAreaProps) {
  const root = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const following = useRef(follow);
  following.current = follow;

  useLayoutEffect(() => {
    const node = root.current;
    const inner = content.current;
    if (!node || !inner) return;
    const follower = createScrollFollower(node);
    const unbind = bindReaderGestures(node, follower);
    const fade = () => {
      node.dataset.fadeTop = String(node.scrollTop > 1);
      node.dataset.fadeBottom = String(node.scrollTop + node.clientHeight < node.scrollHeight - 1);
    };
    // Growth is the only signal that matters: text arrives without a scroll.
    const observer = new ResizeObserver(() => {
      if (following.current) follower.follow();
      fade();
    });
    observer.observe(node);
    observer.observe(inner);
    const onScroll = () => {
      follower.track();
      fade();
    };
    node.addEventListener('scroll', onScroll, { passive: true });
    fade();
    return () => {
      observer.disconnect();
      node.removeEventListener('scroll', onScroll);
      unbind();
      follower.destroy();
    };
  }, []);

  return (
    <div {...props} ref={root} data-scroll-viewport className={`scroll-area ${className}`}>
      <div ref={content} className="scroll-area-content">
        {children}
      </div>
    </div>
  );
}
