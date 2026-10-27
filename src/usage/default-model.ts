/**
 * Which model a run starts on: the explicit default when the operator set one,
 * otherwise the most-used usable model from recorded usage. Nothing here writes
 * settings back - only the explicit settings commands change the default; a
 * model picked in any session belongs to that session.
 */
import { ActivityLedger, type UsageRow } from '../activity-ledger.js';
import { modelIsUsable } from '../provider/registry.js';
import type { SettingsStore } from '../settings.js';

/** Long enough to see habits, short enough to forget a replaced machine. */
const USAGE_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;

export interface DefaultModelChoice {
  providerId: string;
  modelId: string;
  source: 'settings' | 'usage';
  /** Requests behind an automatic choice; absent for an explicit default. */
  requests?: number;
}

/** The most-requested usable model; ties go to the most recently used. Pure over rows so tests need no database. */
export function pickMostUsedModel(
  settings: SettingsStore,
  rows: readonly UsageRow[],
): { providerId: string; modelId: string; requests: number } | null {
  const ranked = new Map<string, { providerId: string; modelId: string; requests: number; lastMs: number }>();
  for (const row of rows) {
    if (!row.providerId || !row.modelId) continue;
    const key = `${row.providerId}::${row.modelId}`;
    const entry = ranked.get(key) ?? { providerId: row.providerId, modelId: row.modelId, requests: 0, lastMs: 0 };
    entry.requests += 1;
    entry.lastMs = Math.max(entry.lastMs, row.atMs);
    ranked.set(key, entry);
  }
  const usable = [...ranked.values()].filter((entry) => modelIsUsable(settings, entry.providerId, entry.modelId));
  usable.sort((left, right) => right.requests - left.requests || right.lastMs - left.lastMs);
  const best = usable[0];
  return best ? { providerId: best.providerId, modelId: best.modelId, requests: best.requests } : null;
}

/** The default as a run should see it; `ledger` injects usage rows in tests. */
export function resolveDefaultModel(settings: SettingsStore, ledger?: Pick<ActivityLedger, 'usageRows'>): DefaultModelChoice | null {
  if (settings.defaultProvider && settings.defaultModel) {
    return { providerId: settings.defaultProvider, modelId: settings.defaultModel, source: 'settings' };
  }
  const rows = (ledger ?? new ActivityLedger(undefined, { readOnly: true })).usageRows({
    sinceMs: Date.now() - USAGE_WINDOW_MS,
  });
  const picked = pickMostUsedModel(settings, rows);
  return picked ? { ...picked, source: 'usage' } : null;
}
