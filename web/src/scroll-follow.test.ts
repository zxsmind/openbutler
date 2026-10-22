import { describe, expect, it, vi } from 'vitest';
import { createScrollFollower } from './scroll-follow.js';

/** The shape the follower actually drives; the DOM around it is irrelevant here. */
interface ScrollNode {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

function fakeScroller(scrollHeight: number, clientHeight: number) {
  const node: ScrollNode = { scrollTop: 0, scrollHeight, clientHeight };
  return { node, followerNode: node as unknown as HTMLElement };
}

function stubBrowser() {
  const frames: FrameRequestCallback[] = [];
  vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) });
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.push(callback);
    return frames.length;
  });
  vi.stubGlobal('cancelAnimationFrame', () => {});
  return frames;
}

describe('scroll follower', () => {
  it('eases towards the bottom on a normal follow and snaps when told to', () => {
    const frames = stubBrowser();
    const { node, followerNode } = fakeScroller(1_000, 400);
    const follower = createScrollFollower(followerNode);
    // The first placement is history, not growth: it lands immediately.
    follower.follow();
    expect(node.scrollTop).toBe(600);
    // Content grows while the reader is pinned: that is eased, so the tail does
    // not jump under the reader's eyes.
    node.scrollHeight = 1_200;
    follower.follow();
    expect(frames.length).toBe(1);
    // One animation frame moves part of the way, not all of it.
    frames.shift()!(performance.now() + 16);
    expect(node.scrollTop).toBeGreaterThan(600);
    expect(node.scrollTop).toBeLessThan(800);
    // A sent message is a deliberate jump: the reader must not watch the tail
    // glide, which is what made the typing dot bob.
    follower.resume({ immediate: true });
    expect(node.scrollTop).toBe(800);
    vi.unstubAllGlobals();
  });
});
