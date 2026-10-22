export interface OverlayLayoutMetrics {
  anchorGap: number;
  edgeInset: number;
  submenuGap: number;
  panelMinWidth: number;
  panelMaxWidth: number;
  panelMaxHeight: number;
}

export type OverlayPlacement = 'auto' | 'top' | 'bottom' | 'left' | 'right';
export type OverlayAlign = 'start' | 'center' | 'end';

export function measureOverlayPanel(panel: HTMLElement, width?: number | null) {
  const properties = ['width', '--dropdown-panel-available-width', '--dropdown-panel-available-height'].map((name) => ({
    name,
    value: panel.style.getPropertyValue(name),
    priority: panel.style.getPropertyPriority(name),
  }));
  panel.style.setProperty('--dropdown-panel-available-width', '100vw');
  panel.style.setProperty('--dropdown-panel-available-height', '100dvh');
  if (width == null) panel.style.removeProperty('width');
  else panel.style.width = String(width) + 'px';
  const size = { width: panel.offsetWidth, height: panel.offsetHeight };
  for (const { name, value, priority } of properties) {
    if (value) panel.style.setProperty(name, value, priority);
    else panel.style.removeProperty(name);
  }
  return size;
}

export function observeAnchoredOverlayLayout({
  anchor,
  surface,
  panels,
  onUpdate,
}: {
  anchor: HTMLElement;
  surface: HTMLElement;
  panels: readonly HTMLElement[];
  onUpdate: () => void;
}) {
  let pendingFrame: number | null = null;
  const scheduleUpdate = () => {
    if (pendingFrame != null) return;
    pendingFrame = window.requestAnimationFrame(() => {
      pendingFrame = null;
      onUpdate();
    });
  };
  const handleScroll = (event: Event) => {
    if (event.target instanceof Node && surface.contains(event.target)) return;
    scheduleUpdate();
  };
  const observer = new ResizeObserver(scheduleUpdate);
  // An anchor can move when a container resizes without changing its own size.
  for (let element: HTMLElement | null = anchor; element; element = element.parentElement) {
    observer.observe(element);
  }
  for (const panel of panels) observer.observe(panel);
  window.addEventListener('resize', scheduleUpdate);
  window.addEventListener('scroll', handleScroll, true);
  scheduleUpdate();

  return () => {
    if (pendingFrame != null) window.cancelAnimationFrame(pendingFrame);
    observer.disconnect();
    window.removeEventListener('resize', scheduleUpdate);
    window.removeEventListener('scroll', handleScroll, true);
  };
}

export function resolveAnchoredOverlayPosition(input: {
  anchor: Pick<DOMRect, 'top' | 'left' | 'right' | 'bottom' | 'width' | 'height'>;
  panel: { width: number; height: number };
  viewport: { width: number; height: number };
  placement: OverlayPlacement;
  align: OverlayAlign;
  metrics: Pick<OverlayLayoutMetrics, 'anchorGap' | 'edgeInset'>;
}) {
  const { anchor, panel, viewport, metrics } = input;
  const viewportWidth = Math.max(0, viewport.width - metrics.edgeInset * 2);
  const viewportHeight = Math.max(0, viewport.height - metrics.edgeInset * 2);
  const available = (space: number, limit: number) => Math.min(Math.max(0, space), limit);
  const spaces = {
    top: available(anchor.top - metrics.anchorGap - metrics.edgeInset, viewportHeight),
    bottom: available(viewport.height - anchor.bottom - metrics.anchorGap - metrics.edgeInset, viewportHeight),
    left: available(anchor.left - metrics.anchorGap - metrics.edgeInset, viewportWidth),
    right: available(viewport.width - anchor.right - metrics.anchorGap - metrics.edgeInset, viewportWidth),
  };
  const preferred = input.placement === 'auto' ? 'bottom' : input.placement;
  const opposite = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' } as const;
  const vertical = preferred === 'top' || preferred === 'bottom';
  const requiredSpace = vertical ? panel.height : panel.width;
  const placement =
    spaces[preferred] >= requiredSpace || spaces[preferred] >= spaces[opposite[preferred]] ? preferred : opposite[preferred];
  const maxWidth = vertical ? viewportWidth : spaces[placement];
  const maxHeight = vertical ? spaces[placement] : viewportHeight;
  const width = Math.min(panel.width, maxWidth);
  const height = Math.min(panel.height, maxHeight);
  const alignment = { start: 0, center: 0.5, end: 1 }[input.align];
  const alignedLeft = anchor.left + (anchor.width - width) * alignment;
  const alignedTop = anchor.top + (anchor.height - height) * alignment;
  const candidates = {
    top: { top: anchor.top - height - metrics.anchorGap, left: alignedLeft },
    bottom: { top: anchor.bottom + metrics.anchorGap, left: alignedLeft },
    left: { top: alignedTop, left: anchor.left - width - metrics.anchorGap },
    right: { top: alignedTop, left: anchor.right + metrics.anchorGap },
  };
  const candidate = candidates[placement];
  const maxLeft = Math.max(metrics.edgeInset, viewport.width - width - metrics.edgeInset);
  const maxTop = Math.max(metrics.edgeInset, viewport.height - height - metrics.edgeInset);
  return {
    placement,
    left: Math.min(Math.max(metrics.edgeInset, candidate.left), maxLeft),
    top: Math.min(Math.max(metrics.edgeInset, candidate.top), maxTop),
    maxWidth,
    maxHeight,
  };
}

function cssLengthToPixels(value: string, rootFontSize: number, elementFontSize: number): number {
  const normalized = value.trim();
  const amount = Number.parseFloat(normalized);
  if (!Number.isFinite(amount)) {
    throw new Error(`Invalid overlay layout length: ${normalized || '(empty)'}`);
  }

  if (normalized.endsWith('rem')) {
    return amount * rootFontSize;
  }
  if (normalized.endsWith('em')) {
    return amount * elementFontSize;
  }
  if (normalized.endsWith('px')) {
    return amount;
  }
  if (amount === 0) {
    return 0;
  }

  throw new Error(`Overlay layout lengths must use rem, em, or px: ${normalized}`);
}

export function readOverlayLayoutMetrics(element: HTMLElement): OverlayLayoutMetrics {
  const styles = window.getComputedStyle(element);
  const rootFontSize = Number.parseFloat(window.getComputedStyle(document.documentElement).fontSize);
  const elementFontSize = Number.parseFloat(styles.fontSize);
  if (!Number.isFinite(rootFontSize) || !Number.isFinite(elementFontSize)) {
    throw new Error('Could not resolve overlay layout font sizes');
  }

  const readLength = (property: string) => cssLengthToPixels(styles.getPropertyValue(property), rootFontSize, elementFontSize);

  return {
    anchorGap: readLength('--mb-overlay-anchor-gap'),
    edgeInset: readLength('--mb-overlay-edge-inset'),
    submenuGap: readLength('--mb-overlay-submenu-gap'),
    panelMinWidth: readLength('--mb-overlay-panel-min-width'),
    panelMaxWidth: readLength('--mb-overlay-panel-max-width'),
    panelMaxHeight: readLength('--mb-overlay-panel-max-height'),
  };
}
