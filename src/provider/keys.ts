/**
 * Provider credentials, shared by the CLI and the web server.
 *
 * Keys live in the secret store: `saveSettings` splits them out of settings.yaml
 * into config.yaml, so nothing here ever needs to know where they are written.
 * Callers must save afterwards.
 */
import type { SettingsStore } from '../settings.js';

/** Appends keys to a provider, creating a fresh enabled entry when needed. Returns how many were new. */
export function addProviderKeys(store: SettingsStore, providerId: string, keys: string[]): number {
  const normalized = keys.map((key) => key.trim()).filter((key) => key.length > 0);
  if (normalized.length === 0) return 0;
  const existing = store.providers[providerId] ?? { enabled: true, keys: [] };
  const merged = [...existing.keys];
  for (const key of normalized) if (!merged.includes(key)) merged.push(key);
  const added = merged.length - existing.keys.length;
  store.providers[providerId] = { ...existing, keys: merged };
  if (!store.providerOrder.includes(providerId)) store.providerOrder.push(providerId);
  return added;
}
