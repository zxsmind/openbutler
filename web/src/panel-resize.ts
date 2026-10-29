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

/** Mirrors --ui-sidebar-width in styles.css: what an untouched sidebar shows. */
export const SIDEBAR_DEFAULT_WIDTH = 252;
export const SIDEBAR_MIN_WIDTH = 180;
export const SIDEBAR_MAX_WIDTH = 560;
/** The conversation keeps at least this much beside the sidebar, so a drag cannot eat it. */
export const SIDEBAR_CHAT_MIN_WIDTH = 480;

/**
 * The sidebar grows rightward, so distance is pointer movement to the right and
 * there is no snap-close: the header button owns closing. `maximum` is the
 * caller's viewport-aware cap, floored at the minimum so a narrow window still
 * allows a drag.
 */
export function resolveSidebarResize(initialWidth: number, distance: number, maximum: number): number {
  const cap = Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, maximum));
  return Math.min(cap, Math.max(SIDEBAR_MIN_WIDTH, initialWidth + distance));
}
