export const PANEL_DEFAULT_WIDTH = 440;
export const PANEL_MIN_WIDTH = PANEL_DEFAULT_WIDTH;
export const PANEL_CLOSE_THRESHOLD = 96;

/** Only an already-open panel can be resized; opening belongs to the toolbar button. */
export function resolvePanelResize(initialWidth: number, distance: number, maximum: number) {
  if (initialWidth <= 0) return { size: 0, snap: false };
  const size = Math.max(0, Math.min(maximum, initialWidth + distance));
  if (distance < 0 && size <= Math.min(PANEL_CLOSE_THRESHOLD, maximum)) return { size: 0, snap: true };
  return { size: Math.min(maximum, Math.max(PANEL_MIN_WIDTH, size)), snap: false };
}
