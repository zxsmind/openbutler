/**
 * The little bit of live session state a settings section may need.
 *
 * Sections otherwise load what they show themselves; this carries only what the
 * app already holds and cannot be fetched (which model is answering, whether a
 * run is in progress) so a section never has to be handed props by the shell.
 */
import { createContext, useContext, type ReactNode } from 'react';
import type { ApprovalMode, ModelChoice } from '../../types.js';

export interface SettingsSession {
  models: ModelChoice[];
  modelsRevision: number;
  runtime: { providerId?: string; modelId?: string; modelName?: string } | undefined;
  busy: boolean;
  selectModel: (model: ModelChoice) => void;
  selectApprovalMode: (mode: ApprovalMode) => Promise<unknown>;
}

const SettingsSessionContext = createContext<SettingsSession | null>(null);

export function SettingsSessionProvider({ value, children }: { value: SettingsSession; children: ReactNode }) {
  return <SettingsSessionContext.Provider value={value}>{children}</SettingsSessionContext.Provider>;
}

export function useSettingsSession(): SettingsSession {
  const value = useContext(SettingsSessionContext);
  if (!value) throw new Error('A settings section must render inside SettingsSessionProvider.');
  return value;
}
