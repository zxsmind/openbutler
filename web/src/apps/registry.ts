import { lazy, type ComponentType } from 'react';
import type { IconName } from '../components/icon.js';

export interface PanelApp {
  id: string;
  title: string;
  tabTitle?: string;
  icon: IconName;
  showNavigation?: boolean;
  component: ComponentType<{ sessionId: string }>;
}

/** Application catalog for the workspace panel. */
export const panelApps: readonly PanelApp[] = [
  {
    id: 'terminal',
    title: 'Terminal',
    icon: 'terminal',
    showNavigation: false,
    component: lazy(() => import('./terminal-app.js').then((module) => ({ default: module.TerminalApp }))),
  },
  {
    id: 'files',
    title: 'Files',
    tabTitle: 'Open file',
    icon: 'file',
    showNavigation: false,
    component: lazy(() => import('./files-app.js').then((module) => ({ default: module.FilesApp }))),
  },
];
