import { describe, expect, it } from 'vitest';
import { resolvePanelResize } from './panel-resize.js';

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
