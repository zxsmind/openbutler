import { useCallback, useRef, useState, useEffect, useLayoutEffect, type CSSProperties, type ReactNode } from 'react';
import { ApplicationPanel, panelTransitionMs } from './application-panel.js';
import { PANEL_DEFAULT_WIDTH, PANEL_MIN_WIDTH, resolvePanelResize } from '../panel-resize.js';
import { useEdgeResize } from '../edge-resize.js';
import { subscribeFileLink } from '../file-links.js';
import './workspace-panels.css';

const storageKey = 'ranite:workspace-panels:v1';

function readWidth(): number {
  try {
    const value = JSON.parse(localStorage.getItem(storageKey) || '{}');
    return Number.isFinite(value.right) && value.right > 0 ? Math.max(PANEL_MIN_WIDTH, value.right) : 0;
  } catch {
    return 0;
  }
}

interface PanelControls {
  panelOpen: boolean;
  togglePanel: () => void;
}

export function WorkspacePanels({
  children,
  sessionId,
  chatTitle,
}: {
  children: (controls: PanelControls) => ReactNode;
  sessionId: string;
  chatTitle: string;
}) {
  const root = useRef<HTMLDivElement>(null);
  const main = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(readWidth);
  const [maximum, setMaximum] = useState(0);
  const [panelMotion, setPanelMotion] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [selectedSurface, setSelectedSurface] = useState<'chat' | 'tool'>('tool');
  const restoreWidth = useRef(PANEL_DEFAULT_WIDTH);
  const motionTimer = useRef<number | null>(null);

  useLayoutEffect(() => {
    if (!root.current) return;
    const measure = () => setMaximum(Math.max(0, root.current!.getBoundingClientRect().width - 5));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(root.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (maximum > 0 && width >= maximum) setExpanded(true);
  }, [maximum, width]);
  useEffect(
    () => () => {
      if (motionTimer.current !== null) window.clearTimeout(motionTimer.current);
    },
    [],
  );

  const visibleWidth = expanded ? maximum : width === 0 ? 0 : Math.min(maximum, Math.max(PANEL_MIN_WIDTH, width));
  const setMotion = useCallback((animate: boolean) => {
    if (motionTimer.current !== null) window.clearTimeout(motionTimer.current);
    motionTimer.current = null;
    setPanelMotion(animate);
    if (animate) {
      motionTimer.current = window.setTimeout(() => {
        motionTimer.current = null;
        setPanelMotion(false);
      }, panelTransitionMs);
    }
  }, []);
  const update = useCallback(
    (value: number, animate = false) => {
      setMotion(animate);
      const next = value <= 0 ? 0 : Math.min(maximum, Math.max(PANEL_MIN_WIDTH, value));
      setExpanded(maximum > 0 && next >= maximum);
      setWidth(next);
    },
    [maximum, setMotion],
  );
  const edge = useEdgeResize({
    direction: -1,
    width: visibleWidth,
    getMaximum: () => maximum,
    resolve: (initial, distance, available) => {
      const resolved = resolvePanelResize(initial, distance, available);
      return { size: resolved.size, end: resolved.snap };
    },
    onStart: () => setMotion(false),
    onResize: (size, end) => update(size, end),
  });
  // Not while the pointer owns the width: the drag's last value is the one worth keeping.
  useEffect(() => {
    if (edge.dragging) return;
    try {
      localStorage.setItem(storageKey, JSON.stringify({ right: width }));
    } catch {
      /* Private browsing can disable storage. */
    }
  }, [width, edge.dragging]);
  const closePanel = () => {
    setSelectedSurface('tool');
    update(0, true);
  };
  const openPanel = useCallback(() => {
    setSelectedSurface('tool');
    update(PANEL_DEFAULT_WIDTH, true);
  }, [update]);
  const togglePanel = () => {
    if (visibleWidth > 0) closePanel();
    else openPanel();
  };
  useEffect(() => {
    // A citation needs the panel it resolves in; opening it is this
    // component's state, so the request has to reach here as well.
    if (visibleWidth > 0) return;
    return subscribeFileLink(() => openPanel());
  }, [openPanel, visibleWidth]);
  useEffect(() => {
    const element = main.current;
    if (!element || maximum === 0 || (visibleWidth > 0 && !(expanded && selectedSurface === 'chat'))) return;
    let swipe: { id: number; x: number; y: number; horizontal: boolean } | null = null;
    const startSwipe = (event: TouchEvent) => {
      swipe = null;
      const target = event.target;
      if (event.touches.length !== 1 || !(target instanceof Element) || !target.closest('.conversation')) return;
      if (target.closest('button, a, input, textarea, select, [contenteditable]:not([contenteditable="false"]), .action-dock')) return;
      if (window.getSelection()?.isCollapsed === false) return;
      // Nested code/table scrollers keep their horizontal gestures.
      for (let node: Element | null = target; node && node !== element; node = node.parentElement) {
        if (node.scrollWidth > node.clientWidth + 1 && /auto|scroll/.test(getComputedStyle(node).overflowX)) return;
      }
      const touch = event.touches[0];
      swipe = { id: touch.identifier, x: touch.clientX, y: touch.clientY, horizontal: false };
    };
    const moveSwipe = (event: TouchEvent) => {
      if (!swipe) return;
      const touch = event.touches[0];
      if (event.touches.length !== 1 || touch.identifier !== swipe.id || window.getSelection()?.isCollapsed === false) {
        swipe = null;
        return;
      }
      const dx = swipe.x - touch.clientX;
      const dy = Math.abs(swipe.y - touch.clientY);
      if (!swipe.horizontal) {
        if ((dy > 10 && dy >= Math.abs(dx)) || dx < -12) {
          swipe = null;
          return;
        }
        if (dx > 12 && dx > dy * 1.5) swipe.horizontal = true;
      }
      if (swipe.horizontal && event.cancelable) event.preventDefault();
    };
    const endSwipe = (event: TouchEvent) => {
      const current = swipe;
      swipe = null;
      if (!current || event.touches.length !== 0) return;
      const touch = Array.from(event.changedTouches).find((candidate) => candidate.identifier === current.id);
      if (!touch) return;
      const dx = current.x - touch.clientX;
      const dy = Math.abs(current.y - touch.clientY);
      if (dx >= 64 && dx > dy * 1.5) openPanel();
    };
    const cancelSwipe = () => {
      swipe = null;
    };
    element.addEventListener('touchstart', startSwipe, { passive: true });
    element.addEventListener('touchmove', moveSwipe, { passive: false });
    element.addEventListener('touchend', endSwipe, { passive: true });
    element.addEventListener('touchcancel', cancelSwipe, { passive: true });
    return () => {
      element.removeEventListener('touchstart', startSwipe);
      element.removeEventListener('touchmove', moveSwipe);
      element.removeEventListener('touchend', endSwipe);
      element.removeEventListener('touchcancel', cancelSwipe);
    };
  }, [expanded, maximum, openPanel, selectedSurface, visibleWidth]);
  const toggleExpanded = () => {
    setMotion(true);
    if (expanded) {
      setExpanded(false);
      setWidth(Math.min(restoreWidth.current, maximum));
    } else {
      restoreWidth.current = visibleWidth || PANEL_DEFAULT_WIDTH;
      setSelectedSurface('tool');
      setExpanded(true);
    }
  };
  return (
    <div
      ref={root}
      className={`workspace-panels${edge.dragging ? ' is-resizing is-resizing-right' : ''}${panelMotion ? ' is-panel-transitioning' : ''}${expanded ? ` panel-expanded-right${selectedSurface === 'chat' ? ' panel-chat-selected' : ''}` : ''}`}
      style={
        {
          '--panel-right': `${visibleWidth}px`,
          '--panel-divider': visibleWidth > 0 ? '5px' : '0px',
          '--panel-duration': `${panelTransitionMs}ms`,
        } as CSSProperties
      }
    >
      <div ref={main} className="workspace-main" inert={expanded && selectedSurface !== 'chat'}>
        {children({ panelOpen: visibleWidth > 0, togglePanel })}
      </div>
      <div
        role="separator"
        tabIndex={0}
        hidden={visibleWidth === 0}
        className="panel-resizer panel-resizer-right"
        aria-label="Resize right panel"
        aria-orientation="vertical"
        aria-controls="workspace-panel-right"
        aria-valuemin={0}
        aria-valuemax={Math.round(maximum)}
        aria-valuenow={Math.round(visibleWidth)}
        aria-valuetext={`${Math.round(visibleWidth)} pixels`}
        title="Drag to resize or close right panel"
        onPointerDown={edge.start}
        onPointerMove={edge.move}
        onPointerUp={edge.finish}
        onPointerCancel={edge.finish}
        onLostPointerCapture={edge.finish}
        onKeyDown={(event) => {
          if (!['ArrowLeft', 'ArrowRight', 'Home', 'End', 'Enter', ' '].includes(event.key)) return;
          event.preventDefault();
          if (['Home', 'Enter', ' '].includes(event.key)) closePanel();
          else update(event.key === 'End' ? maximum : visibleWidth + (event.key === 'ArrowLeft' ? 32 : -32), true);
        }}
      >
        <span />
      </div>
      <ApplicationPanel
        open={visibleWidth > 0}
        sessionId={sessionId}
        expanded={expanded}
        onExpand={toggleExpanded}
        chat={expanded ? { title: chatTitle, selected: selectedSurface === 'chat', onSelect: () => setSelectedSurface('chat') } : undefined}
        onSelectTool={() => setSelectedSurface('tool')}
        onClose={closePanel}
      />
    </div>
  );
}
