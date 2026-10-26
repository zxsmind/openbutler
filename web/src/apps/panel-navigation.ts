export interface PanelTab {
  id: string;
  history: Array<string | null>;
  index: number;
  applications: Record<string, { sessionId: string; revision: number }>;
}

export const newPanelTab = (id: string): PanelTab => ({ id, history: [null], index: 0, applications: {} });

export interface PanelTabsState {
  tabs: PanelTab[];
  active: string;
}

export function removePanelTab(state: PanelTabsState, id: string, homeId: string | null): PanelTabsState {
  if (!state.tabs.some((tab) => tab.id === id)) return state;
  const tabs = state.tabs.filter((tab) => tab.id !== id);
  if (!tabs.length && homeId) tabs.push(newPanelTab(homeId));
  return { tabs, active: state.active === id ? (tabs.at(-1)?.id ?? '') : state.active };
}

/** Navigation keeps the running application while visiting its Tools home page. */
export function navigatePanelTab(tab: PanelTab, appId: string | null, sessionId: string): PanelTab {
  if (tab.history[tab.index] === appId) return tab;
  return {
    ...tab,
    history: [...tab.history.slice(0, tab.index + 1), appId],
    index: tab.index + 1,
    applications: !appId || tab.applications[appId] ? tab.applications : { ...tab.applications, [appId]: { sessionId, revision: 0 } },
  };
}

export function movePanelHistory(tab: PanelTab, delta: number): PanelTab {
  const index = Math.max(0, Math.min(tab.history.length - 1, tab.index + delta));
  return { ...tab, index };
}

export function resolvePanelAddress(
  address: string,
  apps: ReadonlyArray<{ id: string; title: string }>,
): { ok: true; appId: string | null } | { ok: false; error: string } {
  const value = address
    .trim()
    .toLowerCase()
    .replace(/^ranite:\/\//, '')
    .replace(/\/$/, '');
  if (!value || value === 'tools' || value === 'home') return { ok: true, appId: null };
  const app = apps.find((item) => item.id.toLowerCase() === value || item.title.toLowerCase() === value);
  return app
    ? { ok: true, appId: app.id }
    : { ok: false, error: 'Enter a workspace tool address, such as ranite://terminal. Web browsing is not available in this panel yet.' };
}
