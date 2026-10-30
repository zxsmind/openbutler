import { confirm, password } from '@inquirer/prompts';
import { getCatalogIndex, listProviderSummaries } from '../provider/catalog.js';
import { addProviderKeys } from '../provider/keys.js';
import { loadSettings, saveSettings, type SettingsStore } from '../settings.js';
import * as ui from './ui.js';

export { addProviderKeys };

export type KeysTarget = { kind: 'provider' } | { kind: 'unknown-provider'; id: string } | { kind: 'mcp-server'; id: string };

/**
 * Decides what a `openbutler keys` target refers to. A provider is anything the
 * catalog knows or anything already configured; an MCP server id is a
 * different credential home and must never land in the key store.
 */
export function classifyKeysTarget(store: SettingsStore, id: string, catalogIds: ReadonlySet<string>): KeysTarget {
  if (id in store.providers || catalogIds.has(id)) return { kind: 'provider' };
  if (id in store.mcpServers) return { kind: 'mcp-server', id };
  return { kind: 'unknown-provider', id };
}

/** Drops every key of a provider while keeping the entry. False when there was nothing to drop. */
export function removeProviderKeys(store: SettingsStore, providerId: string): boolean {
  const existing = store.providers[providerId];
  if (!existing || existing.keys.length === 0) return false;
  store.providers[providerId] = { ...existing, keys: [] };
  return true;
}

export interface ProviderKeySummary {
  id: string;
  enabled: boolean;
  keyCount: number;
  tails: string[];
}

/** One row per configured provider, in provider order. Tails are display-only fragments, never full keys. */
export function describeProviderKeys(store: SettingsStore): ProviderKeySummary[] {
  const ordered = [...store.providerOrder, ...Object.keys(store.providers)];
  const seen = new Set<string>();
  const rows: ProviderKeySummary[] = [];
  for (const id of ordered) {
    if (seen.has(id) || !(id in store.providers)) continue;
    seen.add(id);
    const state = store.providers[id]!;
    rows.push({ id, enabled: state.enabled, keyCount: state.keys.length, tails: state.keys.map((key) => key.slice(-4)) });
  }
  return rows;
}

/**
 * Collects API keys with a masked prompt. The loop names the owning provider
 * first, so a label can never be mistaken for a value to type in.
 */
async function askKeys(owner: string): Promise<string[]> {
  const keys: string[] = [];
  for (;;) {
    const key = await password({
      message: keys.length === 0 ? `Paste the API key for ${owner}` : `Paste another key for ${owner} (empty to finish)`,
      mask: true,
    });
    if (!key.trim()) {
      if (keys.length > 0) return keys;
      ui.warn(`${owner} needs at least one API key.`);
      continue;
    }
    keys.push(key.trim());
    ui.success(`${owner}: key ${keys.length} stored (shown later as …${key.trim().slice(-4)}).`);
    const more = await confirm({ message: `${owner}: add another key?`, default: false });
    if (!more) return keys;
  }
}

/** Provider ids the catalog knows. An unreadable catalog degrades to "configured providers only", never to a failure. */
async function loadCatalogIds(): Promise<Set<string>> {
  try {
    await getCatalogIndex();
    return new Set(listProviderSummaries().map((entry) => entry.id));
  } catch {
    return new Set();
  }
}

/** Usage: openbutler keys [add <provider>|list|remove <provider>] */
export async function runKeysCommand(action: string, target: string): Promise<void> {
  const settings = loadSettings();
  if (action === 'list' || action === '') {
    const rows = describeProviderKeys(settings);
    if (rows.length === 0) {
      ui.info('No provider is configured.');
      ui.info('Add one with: openbutler keys add <provider>');
      return;
    }
    ui.table(
      ['PROVIDER', 'STATE', 'KEYS', 'ENDING'],
      rows.map((row) => [row.id, row.enabled ? 'on' : 'off', String(row.keyCount), row.tails.map((tail) => `…${tail}`).join(' ')]),
    );
    return;
  }
  if (action !== 'add' && action !== 'remove') throw new Error('Usage: openbutler keys [add <provider>|list|remove <provider>]');
  if (!target) throw new Error(`Usage: openbutler keys ${action} <provider>`);
  if (!process.stdin.isTTY)
    throw new Error(
      `openbutler keys ${action} needs an interactive terminal. Keys are entered through a masked prompt, never as arguments.`,
    );
  const classification = classifyKeysTarget(settings, target, await loadCatalogIds());
  if (classification.kind === 'mcp-server') {
    throw new Error(
      `"${target}" is an MCP server, not a model provider. MCP credentials live in host environment variables referenced by name in the server definition; manage them with openbutler mcp. This store holds model provider API keys only.`,
    );
  }
  if (classification.kind === 'unknown-provider') {
    throw new Error(`Unknown provider "${target}". Configure it first with openbutler setup.`);
  }
  if (action === 'add') {
    const added = addProviderKeys(settings, target, await askKeys(target));
    if (added === 0) {
      ui.info('Nothing added.');
      return;
    }
    saveSettings(settings);
    ui.success(`${target}: ${added === 1 ? '1 key' : `${added} keys`} saved to the secret store.`);
    return;
  }
  const existing = settings.providers[target];
  if (!existing || existing.keys.length === 0) {
    ui.info(`${target} has no stored keys.`);
    return;
  }
  const confirmed = await confirm({
    message: `Remove ${existing.keys.length === 1 ? '1 key' : `${existing.keys.length} keys`} for ${target}?`,
    default: false,
  });
  if (!confirmed) {
    ui.info('Cancelled. Nothing was written.');
    return;
  }
  removeProviderKeys(settings, target);
  saveSettings(settings);
  ui.success(`${target}: keys removed. The provider entry itself stays.`);
}
