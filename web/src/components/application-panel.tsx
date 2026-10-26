import { Suspense, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { panelApps } from '../apps/registry.js';
import {
  movePanelHistory,
  navigatePanelTab,
  newPanelTab,
  removePanelTab,
  resolvePanelAddress,
  type PanelTab,
  type PanelTabsState,
} from '../apps/panel-navigation.js';
import { Icon, IconButton } from './ui.js';
import { Dropdown } from './selection/dropdown.js';
import { AnimatePresence, motion, useIsPresent, useReducedMotion } from 'framer-motion';
import { tabBoundsTransition } from './selection/motion-family.js';
import { Feedback } from './feedback.js';

export const panelTransitionMs = 260;

function TabSlot({
  children,
  width,
  reducedMotion,
  onComplete,
}: {
  children: ReactNode;
  width: number;
  reducedMotion: boolean | null;
  onComplete: () => void;
}) {
  const present = useIsPresent();
  return (
    <motion.div
      className="panel-tab-slot"
      inert={!present}
      aria-hidden={!present}
      initial={reducedMotion ? false : { width: 0, marginRight: 0 }}
      animate={{ width, marginRight: 5 }}
      exit={{ width: 0, marginRight: 0 }}
      transition={reducedMotion ? { duration: 0 } : tabBoundsTransition}
      onAnimationComplete={onComplete}
    >
      {children}
    </motion.div>
  );
}

export interface PanelChatTab {
  title: string;
  selected: boolean;
  onSelect: () => void;
}

export function ApplicationPanel({
  open,
  sessionId,
  onClose,
  expanded,
  onExpand,
  chat,
  onSelectTool,
}: {
  open: boolean;
  sessionId: string;
  onClose: () => void;
  expanded: boolean;
  onExpand: () => void;
  chat?: PanelChatTab | undefined;
  onSelectTool: () => void;
}) {
  const reducedMotion = useReducedMotion();
  const [present, setPresent] = useState(open);
  useEffect(() => {
    if (open) {
      setPresent(true);
      return;
    }
    const timer = window.setTimeout(() => setPresent(false), panelTransitionMs + 20);
    return () => window.clearTimeout(timer);
  }, [open]);
  const nextTab = useRef(0);
  const tabStrip = useRef<HTMLDivElement>(null);
  const tabArea = useRef<HTMLDivElement>(null);
  const activeTab = useRef<HTMLDivElement>(null);
  const [tabAreaWidth, setTabAreaWidth] = useState(275);
  const [panel, setPanel] = useState<PanelTabsState>({ tabs: [newPanelTab('home')], active: 'home' });
  const { tabs, active } = panel;
  const setTabs = (update: (tabs: PanelTab[]) => PanelTab[]) => setPanel((previous) => ({ ...previous, tabs: update(previous.tabs) }));
  const setActive = (id: string) => {
    setPanel((previous) => (previous.tabs.some((tab) => tab.id === id) ? { ...previous, active: id } : previous));
    onSelectTool();
  };
  const count = Math.max(1, tabs.length + (chat ? 1 : 0));
  const tabWidth = Math.max(64, Math.min(238, (tabAreaWidth - 37 - count * 5) / count));
  useEffect(() => {
    if (!chat && !tabs.length) setPanel({ tabs: [newPanelTab('home')], active: 'home' });
  }, [chat, tabs.length]);
  useLayoutEffect(() => {
    const observer = new ResizeObserver(([entry]) => {
      if (entry.contentRect.width > 0) setTabAreaWidth(entry.contentRect.width);
    });
    if (tabArea.current) observer.observe(tabArea.current);
    return () => observer.disconnect();
  }, []);
  const current = tabs.find((tab) => tab.id === active) ?? newPanelTab('empty');
  const destination = current.history[current.index];
  const activeApp = panelApps.find((app) => app.id === destination);
  const [address, setAddress] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    setAddress(destination ? `ranite://${destination}` : '');
    setNotice(null);
  }, [active, destination]);
  useLayoutEffect(() => {
    const reveal = () => activeTab.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    reveal();
    const observer = new ResizeObserver(reveal);
    if (tabStrip.current) observer.observe(tabStrip.current);
    return () => observer.disconnect();
  }, [active, chat?.selected]);
  const add = () => {
    const tab = newPanelTab(`tab-${++nextTab.current}`);
    setPanel((previous) => (previous.tabs.length >= 4 ? previous : { tabs: [...previous.tabs, tab], active: tab.id }));
    onSelectTool();
  };
  const close = (id: string) => {
    setPanel((previous) => removePanelTab(previous, id, `tab-${++nextTab.current}`));
    if (tabs.length === 1 && tabs[0].id === id) {
      onClose();
    }
  };
  const navigate = (id: string, appId: string | null) => {
    if (appId && !sessionId) {
      setNotice('Connect to your workspace before opening a tool.');
      return;
    }
    setNotice(null);
    setTabs((previous) => previous.map((tab) => (tab.id === id ? navigatePanelTab(tab, appId, sessionId) : tab)));
  };
  const history = (delta: number) => setTabs((previous) => previous.map((tab) => (tab.id === active ? movePanelHistory(tab, delta) : tab)));
  const reload = () => {
    setNotice(null);
    setAddress(destination ? `ranite://${destination}` : '');
    if (destination)
      setTabs((previous) =>
        previous.map((tab) =>
          tab.id === active
            ? {
                ...tab,
                applications: {
                  ...tab.applications,
                  [destination]: { ...tab.applications[destination], revision: tab.applications[destination].revision + 1 },
                },
              }
            : tab,
        ),
      );
  };
  return (
    <aside
      id="workspace-panel-right"
      className="workspace-panel workspace-panel-right"
      hidden={!open && !present}
      aria-hidden={!open}
      inert={!open}
      aria-label="Right applications"
      onKeyDown={(event) => event.stopPropagation()}
    >
      <header className="workspace-panel-header">
        <div className="panel-tab-strip" ref={tabArea}>
          <div className="panel-tabs" ref={tabStrip}>
            <AnimatePresence initial={false}>
              {chat ? (
                <TabSlot key="chat" width={tabWidth} reducedMotion={reducedMotion} onComplete={() => {}}>
                  <div
                    className={`panel-tab panel-tab-chat${chat.selected ? ' is-active' : ''}`}
                    ref={chat.selected ? activeTab : undefined}
                  >
                    {chat.selected ? <span className="panel-tab-surface" /> : null}
                    <button type="button" aria-pressed={chat.selected} title={chat.title} onClick={chat.onSelect}>
                      <Icon name="message-circle" size={14} />
                      <span>{chat.title}</span>
                    </button>
                  </div>
                </TabSlot>
              ) : null}
              {tabs.map((tab) => {
                const app = panelApps.find((candidate) => candidate.id === tab.history[tab.index]);
                return (
                  <TabSlot
                    key={tab.id}
                    width={tabWidth}
                    reducedMotion={reducedMotion}
                    onComplete={() => {
                      if (tab.id === active && !chat?.selected) activeTab.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
                    }}
                  >
                    <div
                      className={`panel-tab${tab.id === active && !chat?.selected ? ' is-active' : ''}`}
                      ref={tab.id === active && !chat?.selected ? activeTab : undefined}
                    >
                      {tab.id === active && !chat?.selected ? <span className="panel-tab-surface" /> : null}
                      <button type="button" aria-pressed={tab.id === active && !chat?.selected} onClick={() => setActive(tab.id)}>
                        <Icon name={app?.icon ?? 'globe'} size={14} />
                        <span>{app?.tabTitle ?? app?.title ?? 'New tab'}</span>
                      </button>
                      <IconButton icon="x" label={`Close ${app?.title ?? 'new tab'}`} onClick={() => close(tab.id)} />
                    </div>
                  </TabSlot>
                );
              })}
            </AnimatePresence>
          </div>
          <IconButton icon="plus" label="New tab" disabled={tabs.length >= 4} onClick={add} />
        </div>
        <div className="panel-window-actions">
          <IconButton icon={expanded ? 'minimize' : 'maximize'} label={expanded ? 'Restore panel' : 'Expand panel'} onClick={onExpand} />
          <IconButton icon="panel-right-close" label="Collapse right panel" onClick={onClose} />
        </div>
      </header>
      <div className="panel-navigation" hidden={chat?.selected || activeApp?.showNavigation === false}>
        <div className="panel-navigation-buttons">
          <IconButton icon="arrow-left" label="Back" disabled={current.index === 0} onClick={() => history(-1)} />
          <IconButton
            icon="arrow-right"
            label="Forward"
            disabled={current.index === current.history.length - 1}
            onClick={() => history(1)}
          />
          <IconButton icon="rotate-cw" label="Reload tool" onClick={reload} />
        </div>
        <form
          className="panel-address"
          onSubmit={(event) => {
            event.preventDefault();
            const result = resolvePanelAddress(address, panelApps);
            if (result.ok) navigate(active, result.appId);
            else setNotice(result.error);
          }}
        >
          <input
            aria-label="Tool address"
            placeholder="Home or tool address"
            value={address}
            autoComplete="off"
            spellCheck={false}
            onFocus={(event) => event.currentTarget.select()}
            onChange={(event) => setAddress(event.target.value)}
          />
        </form>
        <Dropdown
          ariaLabel="Panel actions"
          placement="bottom"
          align="end"
          items={[
            { id: 'home', label: 'Tools home', leading: <Icon name="house" />, onSelect: () => navigate(active, null) },
            { id: 'close', label: 'Close tab', leading: <Icon name="x" />, onSelect: () => close(active) },
          ]}
          renderTrigger={({ ref, toggle, open }) => (
            <button
              ref={ref}
              type="button"
              className="panel-navigation-menu"
              aria-label="Panel actions"
              aria-haspopup="menu"
              aria-expanded={open}
              onClick={toggle}
            >
              <Icon name="ellipsis" size={16} />
            </button>
          )}
        />
      </div>
      {notice ? (
        <Feedback tone="warning" className="panel-feedback" onDismiss={() => setNotice(null)}>
          {notice}
        </Feedback>
      ) : null}
      {tabs.map((tab) => {
        const page = tab.history[tab.index];
        return (
          <div key={tab.id} className="panel-app-content" hidden={tab.id !== active || chat?.selected}>
            <div className="panel-home" hidden={page !== null}>
              <div className="panel-home-inner">
                <h2>Tools</h2>
                <div className="panel-tools-grid">
                  {panelApps.map((entry) => (
                    <button
                      type="button"
                      className="panel-tool"
                      key={entry.id}
                      disabled={!sessionId}
                      onClick={() => navigate(tab.id, entry.id)}
                    >
                      <Icon name={entry.icon} size={14} />
                      <span>{entry.title}</span>
                    </button>
                  ))}
                </div>
              </div>
            </div>
            {Object.entries(tab.applications).map(([appId, instance]) => {
              const app = panelApps.find((candidate) => candidate.id === appId)!;
              const Application = app.component;
              return (
                <div key={appId} className="panel-app-view" hidden={page !== appId}>
                  <Suspense fallback={null}>
                    <Application key={instance.revision} sessionId={instance.sessionId} />
                  </Suspense>
                </div>
              );
            })}
          </div>
        );
      })}
    </aside>
  );
}
