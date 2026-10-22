/**
 * Every settings section, in one list.
 *
 * The navigation, the routing and the content all read this array, so the app
 * shell stays unaware of what settings exist: adding one is a file plus a line
 * here.
 */
import type { SettingsSectionDef } from '../settings-page.js';
import { ModelsSettings } from './models.js';
import { ProvidersSettings } from './providers.js';
import { ModalSettings } from './modal.js';
import { UsageSettings } from './usage.js';
import { LogsSettings } from './logs.js';
import { AboutSettings } from './about.js';
import { TelegramSettings } from './telegram.js';
import { ApprovalsSettings } from './approvals.js';
import { MemorySettings } from './memory.js';

export const SETTINGS_SECTIONS: SettingsSectionDef[] = [
  { id: 'providers', label: 'Providers', icon: 'network', render: () => <ProvidersSettings /> },
  { id: 'models', label: 'Models', icon: 'cpu', render: () => <ModelsSettings /> },
  { id: 'modal', label: 'Modal', icon: 'cloud', render: () => <ModalSettings /> },
  { id: 'usage', label: 'Usage', icon: 'chart-no-axes-combined', render: () => <UsageSettings /> },
  { id: 'logs', label: 'Logs', icon: 'scroll-text', render: () => <LogsSettings /> },
  { id: 'approvals', label: 'Approvals', icon: 'shield-check', render: () => <ApprovalsSettings /> },
  { id: 'memory', label: 'Memory', icon: 'brain', render: () => <MemorySettings /> },
  { id: 'telegram', label: 'Telegram', icon: 'send', render: () => <TelegramSettings /> },
  { id: 'about', label: 'About', icon: 'info', render: () => <AboutSettings /> },
];

export const DEFAULT_SETTINGS_SECTION = SETTINGS_SECTIONS[0]!.id;
