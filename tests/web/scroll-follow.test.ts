import { afterEach, beforeEach, expect, it, vi } from 'vitest';
// Load the browser module at runtime without adding DOM globals to Node's typecheck.
const browserModule = '../../web/src/scroll-follow.js';
const { createScrollFollower } = await import(browserModule);

beforeEach(() => {
  vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) });
  vi.stubGlobal(
    'requestAnimationFrame',
    vi.fn(() => 1),
  );
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
});
afterEach(() => vi.unstubAllGlobals());

function viewport() {
  return { scrollTop: 0, scrollHeight: 4774, clientHeight: 800 };
}

it('keeps following when a closing group clamps the scroll before the next group grows', () => {
  const node = viewport();
  const follower = createScrollFollower(node);
  follower.follow({ immediate: true });
  expect(node.scrollTop).toBe(3974);

  // Observed in the browser: collapse clamps the position, then the next group
  // grows before the queued scroll event is handled. No reader gesture occurs.
  node.scrollTop = 3956;
  Object.defineProperty(node, 'scrollHeight', { value: 4809 });
  follower.track();
  expect(follower.pinned).toBe(true);
  follower.follow({ immediate: true });
  expect(node.scrollTop).toBe(4009);
  follower.destroy();
});

it('still releases on reader intent and resumes when the reader returns to the bottom', () => {
  const node = viewport();
  const follower = createScrollFollower(node);
  follower.follow({ immediate: true });
  // bindReaderGestures releases before wheel, touch, keyboard or scrollbar input.
  follower.release();
  node.scrollTop = 3700;
  follower.track();
  follower.follow({ immediate: true });
  expect(follower.pinned).toBe(false);
  expect(node.scrollTop).toBe(3700);
  node.scrollTop = 3974;
  follower.track();
  expect(follower.pinned).toBe(true);
  follower.destroy();
});
