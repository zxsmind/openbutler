import {
  useCallback,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type Ref,
} from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion, useAnimationControls, useReducedMotion } from 'framer-motion';
import { Icon } from '../icon.js';
import { cn } from './cn.js';
import { useOverlayPortal } from './overlay-portal.js';
import { surfaceLayoutTransition, surfaceMotionTransition, surfaceMotionVariants } from './motion-family.js';
import { OverflowMarquee } from './overflow-marquee.js';
import {
  measureOverlayPanel,
  observeAnchoredOverlayLayout,
  readOverlayLayoutMetrics,
  resolveAnchoredOverlayPosition,
  type OverlayAlign,
  type OverlayPlacement,
} from './overlay-layout.js';
import './dropdown.css';

export type DropdownPlacement = OverlayPlacement;
export type DropdownAlign = OverlayAlign;
export type DropdownItemSelectionMode = 'action' | 'single';
export type DropdownPanelRole = 'menu' | 'dialog' | 'none';
export type DropdownNavigationMode = 'submenu' | 'drilldown' | 'custom';
export type DropdownSize = 'sm';

export interface DropdownPanelContext {
  close: () => void;
  goBack: () => void;
}

export interface DropdownMenuItem {
  id: string;
  label: ReactNode;
  value?: ReactNode;
  description?: ReactNode;
  leading?: ReactNode;
  trailing?: ReactNode;
  trailingAction?: ReactNode;
  selected?: boolean;
  disabled?: boolean;
  danger?: boolean;
  showChevron?: boolean;
  separator?: false;
  navigationMode?: DropdownNavigationMode;
  panel?: ReactNode | ((context: DropdownPanelContext) => ReactNode);
  onSelect?: (context: DropdownPanelContext) => void | Promise<void>;
}

export interface DropdownSeparatorItem {
  id: string;
  separator: true;
}

export type DropdownItem = DropdownMenuItem | DropdownSeparatorItem;

export interface DropdownSearch {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  ariaLabel?: string;
}

export interface DropdownRenderContext extends DropdownPanelContext {
  open: boolean;
}

export interface DropdownTriggerProps {
  ref: Ref<HTMLButtonElement>;
  open: boolean;
  toggle: (event: React.MouseEvent<HTMLButtonElement>) => void;
  close: () => void;
}

interface DropdownPosition {
  top: number;
  left: number;
  maxWidth: number;
  maxHeight: number;
}

export interface DropdownProps {
  items?: DropdownItem[];
  header?: {
    title: string;
    onClick?: () => void;
    ariaLabel?: string;
  };
  contentKey?: unknown;
  renderContent?: (context: DropdownRenderContext) => ReactNode;
  footer?: ReactNode | ((context: DropdownPanelContext) => ReactNode);
  search?: DropdownSearch;
  placement?: DropdownPlacement;
  align?: DropdownAlign;
  itemSelectionMode?: DropdownItemSelectionMode;
  panelRole?: DropdownPanelRole;
  navigationMode?: DropdownNavigationMode;
  size?: DropdownSize;
  className?: string;
  panelClassName?: string;
  ariaLabel: string;
  closeOnSelect?: boolean;
  matchTriggerWidthToPanel?: boolean;
  matchPanelWidthToTrigger?: boolean;
  resetKey?: unknown;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  renderTrigger: (props: DropdownTriggerProps) => ReactNode;
}

const SUBMENU_POINTER_GRACE_MS = 120;

function getPanelMode(item: DropdownItem, fallback: DropdownNavigationMode) {
  return item.separator ? fallback : (item.navigationMode ?? fallback);
}

export function Dropdown({
  items = [],
  header,
  contentKey,
  renderContent,
  footer,
  search,
  placement = 'auto',
  align = 'start',
  itemSelectionMode = 'action',
  panelRole = 'menu',
  navigationMode = 'submenu',
  size = 'sm',
  className,
  panelClassName,
  ariaLabel,
  closeOnSelect = true,
  matchTriggerWidthToPanel = false,
  matchPanelWidthToTrigger = false,
  resetKey,
  open: controlledOpen,
  defaultOpen = false,
  onOpenChange,
  renderTrigger,
}: DropdownProps) {
  const portalHost = useOverlayPortal();
  const reducedMotion = useReducedMotion();
  const contentAnimation = useAnimationControls();
  const transition = reducedMotion ? { duration: 0 } : surfaceMotionTransition;
  const layoutTransition = reducedMotion ? { duration: 0 } : surfaceLayoutTransition;
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen);
  const [activeItemId, setActiveItemId] = useState<string | null>(null);
  const [position, setPosition] = useState<DropdownPosition | null>(null);
  const [resolvedPlacement, setResolvedPlacement] = useState<'top' | 'bottom' | 'left' | 'right'>('top');
  const [submenuSide, setSubmenuSide] = useState<'start' | 'end'>('end');
  const [submenuBounds, setSubmenuBounds] = useState<{ maxWidth: number; maxHeight: number } | null>(null);
  const [triggerNaturalWidth, setTriggerNaturalWidth] = useState<number | null>(null);
  const [triggerWidth, setTriggerWidth] = useState<number | null>(null);
  const [panelWidth, setPanelWidth] = useState<number | null>(null);
  const [isSurfaceMounted, setIsSurfaceMounted] = useState(controlledOpen ?? defaultOpen);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const positionRef = useRef<DropdownPosition | null>(null);
  const itemRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const submenuCloseTimerRef = useRef<number | null>(null);
  const wasOpenRef = useRef(false);
  const previousContentKeyRef = useRef(contentKey);

  const open = controlledOpen ?? uncontrolledOpen;
  const activeItem = useMemo(() => items.find((item) => item.id === activeItemId) ?? null, [activeItemId, items]);
  const activeMode = activeItem == null ? null : getPanelMode(activeItem, navigationMode);
  const hasActivePanel = activeItem != null && !activeItem.separator && activeItem.panel != null && activeMode !== 'custom';

  const setOpen = useCallback(
    (nextOpen: boolean) => {
      if (controlledOpen === undefined) {
        setUncontrolledOpen(nextOpen);
      }
      onOpenChange?.(nextOpen);
    },
    [controlledOpen, onOpenChange],
  );

  const goBack = useCallback(() => {
    setSubmenuBounds(null);
    setActiveItemId(null);
  }, []);

  const close = useCallback(() => {
    setSubmenuBounds(null);
    setActiveItemId(null);
    setTriggerWidth(matchTriggerWidthToPanel ? triggerNaturalWidth : null);
    setOpen(false);
  }, [matchTriggerWidthToPanel, setOpen, triggerNaturalWidth]);

  const panelContext = useMemo<DropdownPanelContext>(() => ({ close, goBack }), [close, goBack]);

  const cancelSubmenuClose = useCallback(() => {
    if (submenuCloseTimerRef.current == null) {
      return;
    }

    window.clearTimeout(submenuCloseTimerRef.current);
    submenuCloseTimerRef.current = null;
  }, []);

  const scheduleSubmenuClose = useCallback(() => {
    cancelSubmenuClose();
    submenuCloseTimerRef.current = window.setTimeout(() => {
      submenuCloseTimerRef.current = null;
      goBack();
    }, SUBMENU_POINTER_GRACE_MS);
  }, [cancelSubmenuClose, goBack]);

  const toggle = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      event.preventDefault();
      event.stopPropagation();
      if (open) {
        close();
      } else {
        setTriggerWidth(matchTriggerWidthToPanel ? triggerNaturalWidth : null);
        positionRef.current = null;
        setPosition(null);
        setSubmenuBounds(null);
        setPanelWidth(null);
        setOpen(true);
      }
    },
    [close, matchTriggerWidthToPanel, open, setOpen, triggerNaturalWidth],
  );

  useLayoutEffect(() => {
    if (!matchTriggerWidthToPanel || triggerNaturalWidth != null) {
      return undefined;
    }

    // Measuring after the layout commit keeps the effect free of a
    // synchronous state cascade while still publishing the width before the
    // next interactive frame.
    const frame = window.requestAnimationFrame(() => {
      const measuredWidth = triggerRef.current?.getBoundingClientRect().width;
      if (measuredWidth == null || measuredWidth <= 0) {
        return;
      }

      setTriggerNaturalWidth(measuredWidth);
      if (!open) {
        setTriggerWidth(measuredWidth);
      }
    });

    return () => window.cancelAnimationFrame(frame);
  }, [matchTriggerWidthToPanel, open, triggerNaturalWidth]);

  useEffect(() => {
    if (!open) {
      return undefined;
    }

    const frame = window.requestAnimationFrame(() => setIsSurfaceMounted(true));
    return () => window.cancelAnimationFrame(frame);
  }, [open]);

  const resetFromKey = useEffectEvent(() => {
    positionRef.current = null;
    setPosition(null);
    setSubmenuBounds(null);
    setActiveItemId(null);
    setTriggerWidth(matchTriggerWidthToPanel ? triggerNaturalWidth : null);
    setPanelWidth(null);
    setOpen(false);
  });

  useEffect(() => {
    if (resetKey === undefined) return;
    const frame = window.requestAnimationFrame(() => resetFromKey());

    return () => window.cancelAnimationFrame(frame);
  }, [resetKey]);

  useEffect(() => {
    if (open) {
      return;
    }

    if (wasOpenRef.current) {
      triggerRef.current?.focus();
    }
    wasOpenRef.current = false;
  }, [open]);

  useEffect(() => {
    if (activeItemId == null) {
      cancelSubmenuClose();
    }

    return () => cancelSubmenuClose();
  }, [activeItemId, cancelSubmenuClose]);

  useEffect(() => {
    if (!open) {
      return undefined;
    }

    wasOpenRef.current = true;

    function handlePointerDown(event: PointerEvent) {
      const target = event.target;
      if (!(target instanceof Node)) {
        return;
      }

      if (surfaceRef.current?.contains(target) || triggerRef.current?.contains(target)) {
        return;
      }

      close();
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (
        event.defaultPrevented ||
        (document.activeElement !== triggerRef.current && !surfaceRef.current?.contains(document.activeElement))
      )
        return;

      if (event.key === 'Escape') {
        event.preventDefault();
        if (activeItemId != null && activeMode === 'drilldown') {
          goBack();
        } else {
          close();
        }
        return;
      }

      if (activeItemId != null && activeMode === 'submenu' && event.key === 'ArrowLeft') {
        event.preventDefault();
        goBack();
        return;
      }

      if (activeItemId != null && activeMode === 'drilldown') {
        return;
      }

      if (search && document.activeElement === searchInputRef.current) {
        return;
      }

      const enabledItems = items.filter((item) => !item.separator && !item.disabled);
      if (enabledItems.length === 0) {
        return;
      }

      const focusedId = Object.entries(itemRefs.current).find(([, element]) => element === document.activeElement)?.[0];
      const focusedIndex = enabledItems.findIndex((item) => item.id === focusedId);
      let nextIndex: number | null = null;

      if (event.key === 'ArrowDown') {
        nextIndex = (focusedIndex + 1) % enabledItems.length;
      } else if (event.key === 'ArrowUp') {
        nextIndex = focusedIndex < 0 ? enabledItems.length - 1 : (focusedIndex - 1 + enabledItems.length) % enabledItems.length;
      } else if (event.key === 'Home') {
        nextIndex = 0;
      } else if (event.key === 'End') {
        nextIndex = enabledItems.length - 1;
      } else if (event.key === 'ArrowRight' && focusedId != null) {
        const focusedItem = items.find((item) => item.id === focusedId);
        if (
          focusedItem != null &&
          !focusedItem.separator &&
          focusedItem.panel != null &&
          getPanelMode(focusedItem, navigationMode) !== 'custom'
        ) {
          event.preventDefault();
          setActiveItemId(focusedId);
        }
      }

      if (nextIndex != null) {
        event.preventDefault();
        itemRefs.current[enabledItems[nextIndex]?.id ?? '']?.focus();
      }
    }

    function handleFocusIn(event: FocusEvent) {
      const target = event.target;
      if (!(target instanceof Node)) {
        return;
      }

      if (surfaceRef.current?.contains(target) || triggerRef.current?.contains(target)) {
        return;
      }

      close();
    }

    document.addEventListener('pointerdown', handlePointerDown, true);
    document.addEventListener('focusin', handleFocusIn);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown, true);
      document.removeEventListener('focusin', handleFocusIn);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [activeItemId, activeMode, close, goBack, items, navigationMode, open, search]);

  const updatePosition = useCallback(() => {
    const trigger = triggerRef.current?.getBoundingClientRect();
    const panelElement = panelRef.current;
    if (!trigger || !panelElement) {
      return;
    }

    const metrics = readOverlayLayoutMetrics(panelElement);
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const availableWidth = Math.max(0, viewportWidth - metrics.edgeInset * 2);
    const synchronizedWidth = matchPanelWidthToTrigger ? Math.min(trigger.width, availableWidth) : null;
    const measuredPanel = measureOverlayPanel(panelElement, synchronizedWidth);
    // The root panel remains anchored to the trigger. A submenu may be taller,
    // but it must not pull the root panel upward to match its height.
    const resolved = resolveAnchoredOverlayPosition({
      anchor: trigger,
      panel: measuredPanel,
      viewport: { width: viewportWidth, height: viewportHeight },
      placement,
      align,
      metrics,
    });
    const preferredPlacement = resolved.placement;
    const { top, left } = resolved;
    const panelWidth = Math.min(measuredPanel.width, resolved.maxWidth);
    const submenuWidth = Math.min(metrics.panelMinWidth, availableWidth);
    setPanelWidth((current) => (current === panelWidth ? current : panelWidth));
    if (matchTriggerWidthToPanel) {
      setTriggerWidth((current) => (current === panelWidth ? current : panelWidth));
    }

    const currentPosition = positionRef.current;

    if (hasActivePanel && activeMode === 'submenu') {
      const fitsEnd = left + panelWidth + metrics.submenuGap + submenuWidth <= viewportWidth - metrics.edgeInset;
      const fitsStart = left - metrics.submenuGap - submenuWidth >= metrics.edgeInset;
      const availableEnd = Math.max(0, viewportWidth - metrics.edgeInset - left - panelWidth - metrics.submenuGap);
      const availableStart = Math.max(0, left - metrics.edgeInset - metrics.submenuGap);
      const nextSide = fitsEnd ? 'end' : fitsStart ? 'start' : availableEnd >= availableStart ? 'end' : 'start';
      const availableSubmenuWidth = nextSide === 'end' ? availableEnd : availableStart;

      setSubmenuSide(nextSide);
      const nextBounds = {
        maxWidth: Math.min(metrics.panelMaxWidth, availableSubmenuWidth),
        maxHeight: Math.min(metrics.panelMaxHeight, Math.max(1, viewportHeight - top - metrics.edgeInset)),
      };
      setSubmenuBounds((current) =>
        current != null && current.maxWidth === nextBounds.maxWidth && current.maxHeight === nextBounds.maxHeight ? current : nextBounds,
      );
    } else {
      setSubmenuBounds(null);
    }

    setResolvedPlacement(preferredPlacement);
    const nextPosition = { top, left, maxWidth: resolved.maxWidth, maxHeight: resolved.maxHeight };
    if (
      currentPosition == null ||
      currentPosition.top !== nextPosition.top ||
      currentPosition.left !== nextPosition.left ||
      currentPosition.maxWidth !== nextPosition.maxWidth ||
      currentPosition.maxHeight !== nextPosition.maxHeight
    ) {
      positionRef.current = nextPosition;
      setPosition(nextPosition);
    }
  }, [activeMode, align, hasActivePanel, matchPanelWidthToTrigger, matchTriggerWidthToPanel, placement]);

  useLayoutEffect(() => {
    if (!open || !isSurfaceMounted) return;
    // Commit the target size and anchor together before Motion projects the
    // layout change. Waiting for the resize observer leaves a displaced frame.
    updatePosition();
    if (reducedMotion) contentAnimation.set({ opacity: 1 });
    else if (previousContentKeyRef.current !== contentKey) {
      contentAnimation.set({ opacity: 0.6 });
      void contentAnimation.start({ opacity: 1, transition: surfaceLayoutTransition });
    }
  }, [contentAnimation, contentKey, isSurfaceMounted, open, reducedMotion, updatePosition]);

  useLayoutEffect(() => {
    if (!open || !isSurfaceMounted) {
      return undefined;
    }
    const anchor = triggerRef.current;
    const panel = panelRef.current;
    const surface = surfaceRef.current;
    if (!anchor || !panel || !surface) return undefined;
    const submenu = surface.querySelector<HTMLElement>('.dropdown__submenu');
    return observeAnchoredOverlayLayout({
      anchor,
      surface,
      panels: submenu ? [panel, submenu] : [panel],
      onUpdate: updatePosition,
    });
  }, [activeItemId, isSurfaceMounted, open, updatePosition]);

  useLayoutEffect(() => {
    const contentChanged = previousContentKeyRef.current !== contentKey;
    previousContentKeyRef.current = contentKey;
    if (!open) {
      return;
    }

    const focusedElement = document.activeElement;
    const focusRetained = focusedElement != null && panelRef.current?.contains(focusedElement);
    if (!position || (focusedElement !== triggerRef.current && (!contentChanged || focusRetained))) {
      return;
    }

    if (search && searchInputRef.current) {
      searchInputRef.current.focus();
      return;
    }

    const focusContainer =
      activeMode === 'submenu' ? surfaceRef.current?.querySelector<HTMLElement>('.dropdown__submenu') : panelRef.current;
    const selectedItem = focusContainer?.querySelector<HTMLElement>(
      '[aria-checked="true"]:not([disabled]), [aria-selected="true"]:not([disabled])',
    );
    if (selectedItem) {
      selectedItem.focus();
      return;
    }

    const firstInteractive = focusContainer?.querySelector<HTMLElement>('[data-dropdown-option]:not([disabled])');
    if (firstInteractive) {
      firstInteractive.focus();
    }
  }, [activeItemId, activeMode, contentKey, open, search, position]);

  const handleItemSelect = useCallback(
    (item: DropdownItem) => {
      if (item.separator || item.disabled) {
        return;
      }

      const mode = getPanelMode(item, navigationMode);
      if (item.panel != null && mode !== 'custom') {
        setActiveItemId(item.id);
        return;
      }

      void item.onSelect?.(panelContext);
      if (closeOnSelect) {
        close();
      }
    },
    [close, closeOnSelect, navigationMode, panelContext],
  );

  const renderPanelContent = useCallback(
    (item: DropdownMenuItem) => {
      if (item.panel == null) {
        return null;
      }
      return typeof item.panel === 'function' ? item.panel(panelContext) : item.panel;
    },
    [panelContext],
  );

  const renderItem = (item: DropdownItem) => {
    if (item.separator) {
      return <div key={item.id} role="separator" className="dropdown__separator" />;
    }

    const hasPanel = item.panel != null && getPanelMode(item, navigationMode) !== 'custom';
    const showChevron = item.showChevron ?? hasPanel;

    const itemButton = (
      <button
        key={item.id}
        ref={(element) => {
          itemRefs.current[item.id] = element;
        }}
        type="button"
        data-dropdown-option="true"
        role={itemSelectionMode === 'single' ? 'menuitemradio' : 'menuitem'}
        tabIndex={-1}
        disabled={item.disabled}
        aria-checked={itemSelectionMode === 'single' ? Boolean(item.selected) : undefined}
        aria-haspopup={hasPanel ? 'menu' : undefined}
        aria-expanded={hasPanel ? activeItemId === item.id : undefined}
        className={cn('dropdown__item', item.selected && 'dropdown__item--selected', item.danger && 'dropdown__item--danger')}
        onClick={() => handleItemSelect(item)}
      >
        {item.leading ? <span className="dropdown__item-leading">{item.leading}</span> : null}
        <span className="dropdown__item-copy">
          <OverflowMarquee active={item.selected} className="dropdown__item-label">
            {item.label}
          </OverflowMarquee>
          {item.description ? <OverflowMarquee className="dropdown__item-description">{item.description}</OverflowMarquee> : null}
        </span>
        {item.value ? <OverflowMarquee className="dropdown__item-value">{item.value}</OverflowMarquee> : null}
        {item.trailing || (itemSelectionMode === 'single' && item.selected) ? (
          <span className="dropdown__item-trailing">{item.trailing ?? <Icon name="check" size={14} />}</span>
        ) : null}
        {showChevron ? (
          <Icon
            name="chevron-right"
            className={cn('dropdown__item-chevron', activeItemId === item.id && 'dropdown__item-chevron--active')}
            size={14}
            aria-hidden="true"
          />
        ) : null}
      </button>
    );

    if (item.trailingAction == null) {
      return itemButton;
    }

    return (
      <div key={item.id} className="dropdown__item-cell">
        {itemButton}
        {item.trailingAction}
      </div>
    );
  };

  const renderFooter = footer == null ? null : typeof footer === 'function' ? footer(panelContext) : footer;

  const rootContent = renderContent?.({ open, close, goBack });
  const rootPanelStyle = {
    ...(position
      ? {
          '--dropdown-panel-available-width': String(position.maxWidth) + 'px',
          '--dropdown-panel-available-height': String(position.maxHeight) + 'px',
        }
      : {}),
    ...(matchPanelWidthToTrigger && panelWidth != null ? { width: String(panelWidth) + 'px' } : {}),
  } as CSSProperties;
  const submenuStyle = submenuBounds
    ? ({
        '--dropdown-submenu-max-width': `${submenuBounds.maxWidth}px`,
        '--dropdown-submenu-max-height': `${submenuBounds.maxHeight}px`,
      } as CSSProperties)
    : undefined;
  const renderRootPanel = () => (
    <>
      {search ? (
        <div className="dropdown__search">
          <Icon name="search" size={14} />
          <input
            ref={searchInputRef}
            type="text"
            className="dropdown__search-input"
            value={search.value}
            placeholder={search.placeholder}
            aria-label={search.ariaLabel}
            onChange={(event) => search.onChange(event.target.value)}
          />
        </div>
      ) : null}
      {rootContent ?? items.map(renderItem)}
    </>
  );

  const activeItemLabel = activeItem != null && !activeItem.separator ? activeItem.label : null;

  const renderDrilldownPanel = () => {
    if (!activeItem || activeItem.separator) {
      return renderRootPanel();
    }

    return (
      <>
        <div className="dropdown__header">
          <button type="button" className="dropdown__back" aria-label="Geri" onClick={goBack}>
            <Icon name="chevron-left" size={14} />
          </button>
          <span>{activeItem.label}</span>
        </div>
        <div className="dropdown__drilldown-content">{renderPanelContent(activeItem)}</div>
      </>
    );
  };

  const surface =
    isSurfaceMounted && portalHost
      ? createPortal(
          <motion.div
            ref={surfaceRef}
            // Fixed viewport coordinates belong to the anchor calculation, not
            // layout projection. Children animate relative to this stable root.
            layoutRoot
            initial="hidden"
            animate={open && position ? 'visible' : 'exit'}
            variants={surfaceMotionVariants}
            transition={{ ...transition, layout: layoutTransition }}
            inert={!open}
            onAnimationComplete={() => {
              if (!open) {
                setIsSurfaceMounted(false);
                positionRef.current = null;
                setPosition(null);
                setPanelWidth(null);
              }
            }}
            className={cn(
              'dropdown-surface',
              `dropdown-surface--${resolvedPlacement}`,
              `dropdown-surface--submenu-${submenuSide}`,
              position ? 'dropdown-surface--positioned' : 'dropdown-surface--unpositioned',
              className,
            )}
            style={position ? { top: position.top, left: position.left } : undefined}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="dropdown-surface__stack">
              <motion.div
                ref={panelRef}
                layout={!reducedMotion}
                layoutDependency={contentKey ?? activeItemId}
                transition={{ layout: layoutTransition }}
                className={cn(
                  'dropdown__panel',
                  `dropdown__panel--${size}`,
                  matchPanelWidthToTrigger && 'dropdown__panel--match-trigger',
                  panelClassName,
                )}
                style={rootPanelStyle}
                role={panelRole === 'none' ? undefined : activeItemId == null || activeMode === 'submenu' ? panelRole : 'group'}
                aria-label={panelRole === 'none' ? undefined : activeItemId == null ? ariaLabel : String(activeItemLabel ?? ariaLabel)}
                onPointerEnter={cancelSubmenuClose}
                onPointerLeave={(event) => {
                  if (activeItemId == null || activeMode !== 'submenu') {
                    return;
                  }

                  const nextTarget = event.relatedTarget;
                  const submenu = surfaceRef.current?.querySelector<HTMLElement>('.dropdown__submenu');
                  if (nextTarget instanceof Node && submenu?.contains(nextTarget)) {
                    return;
                  }

                  scheduleSubmenuClose();
                }}
              >
                {header ? (
                  header.onClick ? (
                    <motion.button
                      layout={reducedMotion ? false : 'position'}
                      transition={{ layout: layoutTransition }}
                      type="button"
                      className="dropdown__title"
                      onClick={header.onClick}
                      aria-label={header.ariaLabel}
                    >
                      <OverflowMarquee>{header.title}</OverflowMarquee>
                    </motion.button>
                  ) : (
                    <motion.div
                      layout={reducedMotion ? false : 'position'}
                      transition={{ layout: layoutTransition }}
                      className="dropdown__title"
                    >
                      <OverflowMarquee>{header.title}</OverflowMarquee>
                    </motion.div>
                  )
                ) : null}
                <motion.div
                  layout={reducedMotion ? false : 'position'}
                  animate={contentAnimation}
                  transition={{ layout: layoutTransition }}
                  className="dropdown__panel-content"
                >
                  {activeItemId != null && activeMode === 'drilldown' ? renderDrilldownPanel() : renderRootPanel()}
                </motion.div>
                {renderFooter && !(activeItemId != null && activeMode === 'drilldown') ? (
                  <motion.div
                    layout={reducedMotion ? false : 'position'}
                    transition={{ layout: layoutTransition }}
                    className="dropdown__footer"
                  >
                    {renderFooter}
                  </motion.div>
                ) : null}
              </motion.div>

              <AnimatePresence initial={false} mode="sync">
                {activeItemId != null && activeMode === 'submenu' && hasActivePanel ? (
                  <motion.div
                    key={`submenu-${activeItemId}`}
                    initial="hidden"
                    animate="visible"
                    exit="exit"
                    variants={surfaceMotionVariants}
                    transition={transition}
                    className="dropdown__panel dropdown__submenu"
                    style={submenuStyle}
                    role="menu"
                    aria-label={String(activeItemLabel ?? ariaLabel)}
                    onPointerEnter={cancelSubmenuClose}
                    onPointerLeave={(event) => {
                      const nextTarget = event.relatedTarget;
                      if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) {
                        return;
                      }
                      goBack();
                    }}
                  >
                    <div className="dropdown__panel-content">{renderPanelContent(activeItem as DropdownMenuItem)}</div>
                  </motion.div>
                ) : null}
              </AnimatePresence>
            </div>
          </motion.div>,
          portalHost,
        )
      : null;

  return (
    <>
      <motion.span
        className={cn('dropdown__root', matchTriggerWidthToPanel && 'dropdown__root--panel-width')}
        initial={false}
        animate={matchTriggerWidthToPanel ? { width: triggerWidth ?? 'auto' } : undefined}
        transition={transition}
      >
        {renderTrigger({
          ref: triggerRef,
          open,
          toggle,
          close,
        })}
      </motion.span>
      {surface}
    </>
  );
}
