import { describe, expect, it } from 'vitest';
import { resolvePanelResize, resolveSidebarResize } from './panel-resize.js';

describe('right panel resizing', () => {
  it('cannot open a closed panel by dragging', () => {
    expect(resolvePanelResize(0, 500, 1200)).toEqual({ size: 0, snap: false });
  });
  it('keeps the minimum width until the close boundary is crossed', () => {
    expect(resolvePanelResize(440, -343, 1200)).toEqual({ size: 440, snap: false });
    expect(resolvePanelResize(440, -344, 1200)).toEqual({ size: 0, snap: true });
  });
  it('resizes directly up to the available workspace', () => {
    expect(resolvePanelResize(440, 100, 1200)).toEqual({ size: 540, snap: false });
    expect(resolvePanelResize(440, 1000, 1200)).toEqual({ size: 1200, snap: false });
    expect(resolvePanelResize(440, 10, 300)).toEqual({ size: 300, snap: false });
  });
});

describe('sidebar resizing', () => {
  it('grows with a rightward drag and shrinks with a leftward one', () => {
    expect(resolveSidebarResize(252, 100, 1200)).toBe(352);
    expect(resolveSidebarResize(252, -52, 1200)).toBe(200);
  });
  it('stops at the floor instead of following the pointer further', () => {
    expect(resolveSidebarResize(252, -100, 1200)).toBe(180);
    expect(resolveSidebarResize(180, -40, 1200)).toBe(180);
  });
  it('caps at the viewport-aware maximum, not just the fixed ceiling', () => {
    expect(resolveSidebarResize(400, 500, 420)).toBe(420);
    expect(resolveSidebarResize(400, 500, 2000)).toBe(560);
    // A viewport that leaves less than the minimum still allows dragging to it.
    expect(resolveSidebarResize(180, 500, 100)).toBe(180);
  });
});
