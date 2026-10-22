/** One owner for automatic scrolling in both the transcript and nested output. */
export interface ScrollFollower {
  readonly pinned: boolean;
  /** Content or viewport geometry changed. */
  follow(options?: { immediate?: boolean }): void;
  /** A new owner message explicitly resumes following, even from history. */
  resume(options?: { immediate?: boolean }): void;
  track(): void;
  release(): void;
  destroy(): void;
}

const BOTTOM_SLACK_PX = 8;
const CATCH_UP_MS = 85;
const MAX_SPEED_PX_PER_MS = 2.4;

export function createScrollFollower(node: HTMLElement): ScrollFollower {
  let pinned = true;
  let initialized = false;
  let frame: number | null = null;
  let lastTime = 0;
  let writtenTop: number | null = null;
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const bottom = () => Math.max(0, node.scrollHeight - node.clientHeight);
  const atBottom = () => bottom() - node.scrollTop <= BOTTOM_SLACK_PX;
  const write = (top: number) => {
    node.scrollTop = top;
    writtenTop = node.scrollTop;
  };
  const cancel = () => {
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
  };
  const step = (now: number) => {
    const elapsed = Math.min(64, Math.max(0, now - lastTime));
    lastTime = now;
    const target = bottom();
    const remaining = target - node.scrollTop;
    if (Math.abs(remaining) <= 1 || reducedMotion.matches) {
      write(target);
      frame = null;
      return;
    }
    // Time-based easing has the same speed at 60, 120 and 240 Hz. Retarget the
    // existing motion as tokens arrive instead of restarting a smooth scroll.
    const distance = Math.min(
      Math.abs(remaining),
      MAX_SPEED_PX_PER_MS * elapsed,
      Math.max(1, Math.abs(remaining) * (1 - Math.exp(-elapsed / CATCH_UP_MS))),
    );
    write(node.scrollTop + Math.sign(remaining) * distance);
    frame = requestAnimationFrame(step);
  };
  const follow = ({ immediate = false }: { immediate?: boolean } = {}) => {
    if (!pinned) return;
    const target = bottom();
    if (immediate || !initialized || reducedMotion.matches) {
      initialized = true;
      cancel();
      write(target);
      return;
    }
    if (Math.abs(target - node.scrollTop) <= 1) return;
    if (frame === null) {
      lastTime = performance.now();
      frame = requestAnimationFrame(step);
    }
  };
  return {
    get pinned() {
      return pinned;
    },
    follow,
    resume(options) {
      pinned = true;
      follow(options);
    },
    track() {
      // Ignore the actual position we wrote, including native clamping when a
      // panel shrinks. A time window could swallow a real reader gesture or
      // expire before a delayed programmatic scroll event arrived.
      if (writtenTop !== null && Math.abs(node.scrollTop - Math.min(writtenTop, bottom())) <= 1) return;
      // Only reader gestures release the follow. A collapsing group can clamp
      // scrollTop before another group grows; its delayed scroll event is not
      // reader intent, even when it no longer matches our last write or bottom.
      if (atBottom()) pinned = true;
      writtenTop = null;
    },
    release() {
      cancel();
      pinned = false;
      writtenTop = null;
    },
    destroy: cancel,
  };
}

/** A nested viewport owns its gestures; they must not unpin its ancestors. */
export function bindReaderGestures(node: HTMLElement, follower: ScrollFollower): () => void {
  const owns = (event: Event) =>
    event.composedPath().find((target) => target instanceof HTMLElement && target.hasAttribute('data-scroll-viewport')) === node;
  const onWheel = (event: WheelEvent) => {
    if (owns(event) && event.deltaY < 0) follower.release();
  };
  let touchY: number | undefined;
  const onTouchStart = (event: TouchEvent) => {
    if (owns(event)) touchY = event.touches[0]?.clientY;
  };
  const onTouch = (event: TouchEvent) => {
    if (!owns(event)) return;
    const next = event.touches[0]?.clientY;
    if (next !== undefined && touchY !== undefined && next > touchY) follower.release();
    touchY = next;
  };
  const onKey = (event: KeyboardEvent) => {
    if (owns(event) && ['ArrowUp', 'PageUp', 'Home'].includes(event.key)) follower.release();
  };
  const onPointerDown = (event: PointerEvent) => {
    // offsetX belongs to the clicked child, not necessarily the scrollport.
    if (event.target !== node) return;
    const left = node.getBoundingClientRect().left + node.clientLeft;
    if (event.clientX < left || event.clientX >= left + node.clientWidth) follower.release();
  };
  const onClick = (event: MouseEvent) => {
    // A reader expanding details wants to keep that control in view. This
    // layout intent applies to ancestor viewports too, unlike wheel gestures.
    if (event.target instanceof Element && event.target.closest('[data-scroll-preserve]')) follower.release();
  };
  node.addEventListener('wheel', onWheel, { passive: true });
  node.addEventListener('touchstart', onTouchStart, { passive: true });
  node.addEventListener('touchmove', onTouch, { passive: true });
  node.addEventListener('keydown', onKey);
  node.addEventListener('pointerdown', onPointerDown);
  node.addEventListener('click', onClick);
  return () => {
    node.removeEventListener('wheel', onWheel);
    node.removeEventListener('touchstart', onTouchStart);
    node.removeEventListener('touchmove', onTouch);
    node.removeEventListener('keydown', onKey);
    node.removeEventListener('pointerdown', onPointerDown);
    node.removeEventListener('click', onClick);
  };
}
