import { confirm, input, password, search, select } from '@inquirer/prompts';
import { getCatalogIndex, getProvider, listProviderSummaries } from '../provider/catalog.js';
import { listToolCapableModels, listSupportedPackages } from '../provider/registry.js';
import { loadSettings, saveSettings, withProviderFields, type ProviderState, type SettingsStore, getSettingsPath } from '../settings.js';
import { BACK_CHOICE, BACK_LABEL, createStepMachine } from './steps.js';
import { defaultModelIsUsable, readiness, setDefaultModel } from './config-edit.js';
import { getDataPath } from '../paths.js';
import { MEMORY_EMBEDDING_DIMENSIONS } from '../memory-index.js';
import { prepareMemoryEmbeddingModelInChild } from '../memory-model-preparation.js';
import * as ui from './ui.js';

/**
 * First-run wizard.
 *
 * Steps are driven by an explicit machine rather than a linear script, so a
 * prompt can offer `← Back` and land on the previous section instead of
 * restarting the whole wizard. Settings are written once at the end, so any
 * number of back-and-forward moves changes nothing on disk until then.
 *
 * Difference from athena's wizard: the model list is filtered to models the
 * catalog says can call tools. Ranite is an agent, so a model that cannot call
 * a tool is not a worse choice, it is not a choice.
 */

/** Splits pasted key/model lists on commas, whitespace, or newlines. */
export function parseList(raw: string): string[] {
  return raw
    .split(/[\s,;]+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/** One-line summary of an LLM provider entry. */
export function summarizeProvider(id: string, state: ProviderState, isDefault: boolean): string {
  const keys = state.keys.length === 1 ? '1 key' : `${state.keys.length} keys`;
  const custom = state.npm ? ` via ${state.npm}` : '';
  const marker = isDefault ? ' *' : '';
  return `${state.enabled ? 'on' : 'off'} ${id}${marker}${custom} — ${keys}`;
}

interface CatalogEntry {
  id: string;
  name: string;
  modelCount: number;
}

/**
 * The catalog listing, built from the index alone.
 *
 * Nothing here reads a provider line: the index already carries the model count
 * for every provider, so opening the wizard over 225 providers costs one small
 * file read rather than the whole catalog.
 */
async function loadCatalog(): Promise<CatalogEntry[]> {
  try {
    await getCatalogIndex();
    return listProviderSummaries()
      .map((entry) => ({ id: entry.id, name: getProviderName(entry.id), modelCount: entry.modelCount }))
      .sort((a, b) => a.id.localeCompare(b.id));
  } catch {
    return [];
  }
}

/** Display name if the provider has already been read, else its id. */
function getProviderName(id: string): string {
  return getProvider(id)?.name ?? id;
}

/** Models the catalog marks as able to call tools, so a choice is never a dead end. */
function toolCapableModels(providerId: string, state: ProviderState | undefined): string[] {
  return listToolCapableModels([providerId], state ? { [providerId]: state } : {}).map((entry) => entry.model);
}

/**
 * Collects API keys for one provider.
 *
 * The prompt names the provider the key belongs to, then asks for the key
 * itself, so a label like "keys" can never be mistaken for a name to type into.
 */
async function askKeys(existing: string[], owner: string): Promise<string[]> {
  const keys = [...existing];
  for (;;) {
    const prompt = keys.length === 0 ? `Paste the API key for ${owner}` : `Paste another key for ${owner} (empty to finish)`;
    const key = await password({ message: prompt, mask: true });
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

/** True when `needle`'s characters appear in `haystack` in order. */
function isSubsequence(needle: string, haystack: string): boolean {
  let index = 0;
  for (const character of haystack) {
    if (character === needle[index]) index += 1;
    if (index === needle.length) return true;
  }
  return needle.length === 0;
}

/**
 * Scores one provider against the search terms.
 *
 * Higher is better, `-1` means no match. The ranking exists so the intended
 * provider lands in the first visible row instead of being buried by an
 * alphabetical list: an exact id beats a name prefix, which beats an id
 * substring, which beats a name substring, which beats a subsequence match.
 */
export function scoreProvider(entry: CatalogEntry, terms: string[]): number {
  if (terms.length === 0) return 0;
  const id = entry.id.toLowerCase();
  const name = entry.name.toLowerCase();

  let total = 0;
  for (const term of terms) {
    if (id === term) total += 1000;
    else if (id.startsWith(term)) total += 500;
    else if (name.startsWith(term)) total += 300;
    else if (id.includes(term)) total += 200;
    else if (name.includes(term)) total += 100;
    else if (isSubsequence(term, id)) total += 20;
    else return -1;
  }
  /* Every extra term matched narrows the result, so rank it higher. */
  return total + terms.length;
}

/**
 * Filters and orders providers for the search prompt.
 *
 * Every match is returned; ordering is score first, then provider count, then
 * alphabetically, so the result is stable between keystrokes.
 */
export function rankProviders(catalog: CatalogEntry[], term: string): CatalogEntry[] {
  const terms = term.toLowerCase().split(/\s+/).filter(Boolean);
  const scored: Array<{ entry: CatalogEntry; score: number }> = [];
  for (const entry of catalog) {
    const score = scoreProvider(entry, terms);
    if (score >= 0) scored.push({ entry, score });
  }
  scored.sort((a, b) => b.score - a.score || b.entry.modelCount - a.entry.modelCount || a.entry.id.localeCompare(b.entry.id));
  return scored.map((item) => item.entry);
}

/** Returns `'back'` when the user asked to go back. */
async function askProviderId(
  catalog: CatalogEntry[],
  already: Set<string>,
  canGoBack: boolean,
): Promise<{ id: string; custom: boolean } | 'back'> {
  const choices: Array<{ value: string; name: string }> = [
    { value: 'catalog', name: `Catalog (${catalog.length || 200}+ providers from models.dev)` },
    { value: 'custom', name: 'Custom endpoint (self-hosted, proxy, local model)' },
  ];
  if (canGoBack) choices.push({ value: BACK_CHOICE, name: BACK_LABEL });
  const kind = await select({ message: 'LLM provider source', choices });
  if (kind === BACK_CHOICE) return 'back';
  if (kind === 'custom') {
    const id = await input({
      message: 'Custom provider id (letters, digits, dashes)',
      validate: (value) => (/^[a-z0-9][a-z0-9-]*$/i.test(value.trim()) ? true : 'Use letters, digits, or dashes.'),
    });
    return { id: id.trim(), custom: true };
  }
  if (catalog.length === 0) {
    ui.warn('No model catalog available (offline and nothing cached). Use a custom endpoint instead.');
    return askProviderId(catalog, already, canGoBack);
  }
  return {
    id: await search({
      message: 'Provider (type to search, ↑↓ to move, enter to pick)',
      pageSize: 12,
      source: async (term) =>
        rankProviders(catalog, term ?? '').map((entry) => ({
          value: entry.id,
          name: `${entry.name}  (${entry.id}, ${entry.modelCount} models)${already.has(entry.id) ? ' — configured' : ''}`,
        })),
    }),
    custom: false,
  };
}

async function configureProvider(settings: SettingsStore, picked: { id: string; custom: boolean }): Promise<void> {
  const { id, custom } = picked;
  const existing = settings.providers[id];
  const npm = custom
    ? await select({
        message: `Runtime package for ${id}`,
        choices: listSupportedPackages().map((name) => ({ value: name })),
      })
    : existing?.npm;
  const url = await input({
    message: custom ? 'Endpoint base URL (required)' : 'Base URL override (empty = catalog default)',
    default: existing?.url ?? '',
    ...(custom ? { validate: (value: string) => (value.trim().length > 0 ? true : 'A custom endpoint needs its URL.') } : {}),
  });
  const keys = await askKeys(existing?.keys ?? [], id);
  settings.providers[id] = withProviderFields(existing, {
    keys,
    ...(url.trim() ? { url: url.trim() } : {}),
    ...(npm ? { npm } : {}),
  });
  if (!settings.providerOrder.includes(id)) settings.providerOrder.push(id);
}

/**
 * Picks the one model a run uses.
 *
 * Provider first, then model, because a custom endpoint has no catalog entry to
 * pick from and asking for its model id up front would mean a free-text prompt on
 * every setup even when the operator is configuring openai.
 */
async function askDefaultModel(settings: SettingsStore): Promise<void> {
  const ids = settings.providerOrder;
  if (ids.length === 0) return;

  const provider = await select({
    message: 'Which provider should ranite use?',
    choices: ids.map((id) => ({ value: id, name: getProvider(id)?.name ?? id })),
    ...(settings.defaultProvider && ids.includes(settings.defaultProvider) ? { default: settings.defaultProvider } : {}),
  });

  const available = toolCapableModels(provider, settings.providers[provider]);
  if (available.length === 0) {
    ui.warn(`No tool-capable model in the catalog for ${provider}; type the model id.`);
    const raw = await input({ message: `Model id for ${provider}`, default: settings.defaultModel });
    const model = parseList(raw)[0] ?? '';
    if (model && setDefaultModel(settings, provider, model)) ui.success(`Default: ${provider} / ${model}`);
    return;
  }

  const picked = await select({
    message: `Which model should ${provider} use?`,
    choices: available.map((model) => ({ value: model, name: model })),
    ...(settings.defaultModel && available.includes(settings.defaultModel) ? { default: settings.defaultModel } : {}),
  });
  if (setDefaultModel(settings, provider, picked)) ui.success(`Default: ${provider} / ${picked}`);
}

function printSummary(settings: SettingsStore): void {
  ui.section('Review');
  const ids = Object.keys(settings.providers);
  if (ids.length === 0) ui.bullet(ui.color.dim('no provider configured'));
  for (const id of ids) ui.bullet(summarizeProvider(id, settings.providers[id], settings.defaultProvider === id));
  ui.line();
  ui.kv(
    'Default model',
    settings.defaultProvider && settings.defaultModel ? `${settings.defaultProvider} / ${settings.defaultModel}` : '(none)',
  );
}

/** Wizard sections, in order. Back navigation walks this list. */
export const SETUP_STEPS = ['llm', 'review'] as const;
export type SetupStep = (typeof SETUP_STEPS)[number];

/** Existing installations can prepare/retry memory without re-entering provider keys. */
export async function prepareLocalMemoryModel(): Promise<boolean> {
  ui.section('Local memory model');
  ui.info('Downloads the model if needed, verifies local inference, then releases its model sessions.');
  ui.kv('Model cache', getDataPath('models'));
  for (;;) {
    const active = ui.spinner({ text: 'Preparing local memory model', discardStdin: false }).start();
    try {
      await prepareMemoryEmbeddingModelInChild((progress) => {
        if (progress.status === 'progress' && progress.total > 0) {
          active.text = `Local memory model: ${progress.file} ${Math.floor(progress.progress)}% (${ui.bytes(progress.loaded)} / ${ui.bytes(progress.total)})`;
        } else if (progress.status === 'ready') {
          active.text = 'Verifying local memory model';
        }
      });
      active.succeed(`Local memory model ready (${MEMORY_EMBEDDING_DIMENSIONS} dimensions).`);
      return true;
    } catch (error) {
      active.fail('Local memory model is not ready.');
      ui.warn(error instanceof Error ? error.message : String(error));
      ui.info('Your settings are kept. Rerun ranite setup and choose the local memory model to retry.');
      if (error instanceof Error && ['ExitPromptError', 'AbortPromptError'].includes(error.name)) {
        process.exitCode = 1;
        return false;
      }
      let decision: string;
      try {
        decision = await select({
          message: 'Memory model preparation failed',
          choices: [
            { value: 'retry', name: 'Retry download and verification' },
            { value: 'exit', name: 'Exit setup (memory search is not ready)' },
          ],
        });
      } catch (promptError) {
        if (!(promptError instanceof Error) || !['ExitPromptError', 'AbortPromptError'].includes(promptError.name)) throw promptError;
        process.exitCode = 1;
        return false;
      }
      if (decision === 'exit') {
        process.exitCode = 1;
        return false;
      }
    }
  }
}

export async function runSetup(): Promise<boolean> {
  ui.section('Setup');
  ui.kv('Data directory', getDataPath());
  ui.kv('Settings file', getSettingsPath());
  const settings = loadSettings();
  if (Object.keys(settings.providers).length > 0) {
    const task = await select({
      message: 'What would you like to set up?',
      choices: [
        { value: 'providers', name: 'Configure LLM providers and prepare local memory' },
        { value: 'memory', name: 'Prepare local memory model only (keep current settings)' },
      ],
    });
    if (task === 'memory') {
      return prepareLocalMemoryModel();
    }
  }
  ui.info('Settings are written at the last step. Ctrl+C cancels before saving.');
  const machine = createStepMachine<SetupStep>(SETUP_STEPS);
  let catalog: CatalogEntry[] = [];

  for (;;) {
    if (machine.current === 'llm') {
      ui.section('LLM providers');
      if (catalog.length === 0) {
        catalog = await ui.step('Loading model catalog', () => loadCatalog());
        if (catalog.length > 0) ui.info(`${catalog.length} catalog providers available.`);
        else ui.warn('Catalog unavailable; only custom endpoints can be configured.');
      }
      for (;;) {
        const picked = await askProviderId(catalog, new Set(Object.keys(settings.providers)), !machine.atStart);
        if (picked === 'back') {
          if (machine.back() === 'abort') return false;
          break;
        }
        await configureProvider(settings, picked);
        const more = await confirm({ message: 'Add another LLM provider?', default: false });
        if (!more) break;
      }
      if (machine.current !== 'llm') continue;
      if (Object.keys(settings.providers).length > 0) await askDefaultModel(settings);
      if (machine.next() === 'finish') return false;
      continue;
    }

    printSummary(settings);
    const decision = await select({
      message: 'What next?',
      choices: [
        { value: 'save', name: 'Save these settings' },
        { value: 'llm', name: '← Back to LLM providers' },
        { value: 'discard', name: 'Discard and exit without saving' },
      ],
    });
    if (decision === 'save') break;
    if (decision === 'discard') {
      ui.warn('Nothing was written.');
      return false;
    }
    machine.goto(SETUP_STEPS.indexOf(decision));
  }

  saveSettings(settings);
  ui.success(`Saved to ${getSettingsPath()}.`);
  ui.line();
  if (!(await prepareLocalMemoryModel())) return false;

  const report = readiness(settings);
  if (!report.ready) {
    ui.warn('Still missing before this can run:');
    for (const problem of report.problems) ui.line(ui.color.red(`    ${problem}`));
    for (const hint of report.hints) ui.info(hint);
    return false;
  }
  if (!defaultModelIsUsable(settings)) {
    ui.warn('The default model is unset or cannot call tools.');
    ui.info('Fix it: ranite setup');
    return false;
  }
  ui.info('Try: ranite --c "is docker installed?"');
  return true;
}
