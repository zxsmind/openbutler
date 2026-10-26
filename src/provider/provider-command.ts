/**
 * The `/provider` chat command: add, list, check, and remove providers from any
 * channel that can reach the session (terminal, web, Telegram), without the
 * agent interpreting the text. The terminal UI keeps its interactive picker for
 * a bare `/provider`; this module owns the argument form the host consumes.
 *
 * Nothing here ever prints key material: lists and checks report counts only,
 * and `remove` touches settings, never the secret store.
 */
import {
  loadSettings,
  rememberProviderModel,
  removeProvider,
  saveSettings,
  upsertProvider,
  type ProviderModelSpec,
  type SettingsStore,
} from '../settings.js';
import { getCatalogIndex, getProvider, isCatalogLoaded } from './catalog.js';
import { createLanguageModel, listSupportedPackages, providerIsConfigured } from './registry.js';
import { createPayloadFetch } from './request-payload.js';

export interface ProviderCommandOutcome {
  notice: string;
  tone: 'info' | 'warn' | 'error';
}

const PROVIDER_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const DEFAULT_NPM = '@ai-sdk/openai-compatible';

const USAGE = [
  'Usage:',
  '/provider add <id> --url <endpoint> [--npm <package>] [--model <id>]...  add or extend a custom provider',
  '  optional: --payload <json> merged into request bodies, --context <tokens>, --output <tokens>, --effort low,high',
  '/provider list  configured providers, their models, and key counts (never key values)',
  '/provider check <id>[/<model>] [--ping]  build the model; --ping also sends one tiny request',
  '/provider remove <id>  drop its settings and its keys',
].join('\n');

export function isProviderCommand(text: string): boolean {
  return /^\/provider(?:\s|$)/.test(text.trim());
}

/** Splits a command line on whitespace, keeping double- or single-quoted runs intact. */
function tokenize(text: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  for (const char of text) {
    if (quote !== null) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    // A quote opens a quoted run only at a token boundary; anywhere else it is
    // literal, so compact JSON like {"reasoning_effort":"low"} survives intact.
    if ((char === '"' || char === "'") && current === '') {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) tokens.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  if (current) tokens.push(current);
  return tokens;
}

function fail(notice: string): ProviderCommandOutcome {
  return { notice, tone: 'error' };
}

function providerLine(id: string, settings: SettingsStore): string {
  const state = settings.providers[id];
  if (!state) return `${id}: not found`;
  const custom = Boolean(state.npm) || Boolean(state.url);
  const configured = providerIsConfigured(id, state);
  const models = state.models?.length ? state.models.join(', ') : '(no model)';
  const parts = [
    `${id}${custom ? ' [custom]' : ''}${state.enabled ? '' : ' [disabled]'}`,
    configured ? 'ready' : 'needs a key',
    `models: ${models}`,
    `keys: ${state.keys.length}`,
  ];
  if (state.url) parts.push(state.url);
  if (settings.defaultProvider === id) parts.push(`default: ${settings.defaultModel || '(unset)'}`);
  return parts.join(' — ');
}

async function addProvider(settings: SettingsStore, tokens: string[]): Promise<ProviderCommandOutcome> {
  const id = tokens[2];
  if (!id || !PROVIDER_ID.test(id)) return fail('Add needs a provider id: /provider add <id> --url <endpoint> --model <id>');
  const valueFlags = ['--url', '--npm', '--model', '--payload', '--effort', '--context', '--output'];
  let url: string | undefined;
  let npm: string | undefined;
  let payload: Record<string, unknown> | undefined;
  let context: number | undefined;
  let output: number | undefined;
  let efforts: string[] | undefined;
  const models: string[] = [];
  for (let index = 3; index < tokens.length; index += 1) {
    const flag = tokens[index];
    const value = tokens[index + 1];
    if (valueFlags.includes(flag)) {
      if (!value || value.startsWith('--')) return fail(`${flag} needs a value.`);
      index += 1;
      if (flag === '--url') url = value;
      else if (flag === '--npm') npm = value;
      else if (flag === '--model') models.push(value);
      else if (flag === '--effort') {
        efforts = value
          .split(',')
          .map((entry) => entry.trim())
          .filter(Boolean);
        if (efforts.length === 0) return fail('--effort needs at least one value, e.g. --effort low,high');
      } else if (flag === '--payload') {
        let parsed: unknown;
        try {
          parsed = JSON.parse(value);
        } catch {
          return fail('--payload must be valid JSON (compact, or wrapped in single quotes), e.g. --payload {"reasoning_effort":"low"}');
        }
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return fail('--payload must be a JSON object.');
        payload = parsed as Record<string, unknown>;
      } else {
        const count = Number(value);
        if (!Number.isSafeInteger(count) || count < 1) return fail(`${flag} must be a positive whole number of tokens.`);
        if (flag === '--context') context = count;
        else output = count;
      }
      continue;
    }
    return fail(`Unknown option: ${flag}\n${USAGE}`);
  }
  if (!url) return fail(`Add needs an endpoint: --url <endpoint> (no /chat/completions suffix; the runtime adds it).\n${USAGE}`);
  if (!/^https?:\/\//.test(url)) return fail('The endpoint must be an http(s) URL.');
  if (models.length === 0) return fail('Add at least one model: --model <id>');

  const runtime = npm ?? DEFAULT_NPM;
  upsertProvider(settings, id, { enabled: true, url, npm: runtime, ...(payload ? { payload } : {}) });
  for (const model of models) {
    rememberProviderModel(settings, id, model);
    const spec: ProviderModelSpec = { ...(settings.providers[id]?.modelSpecs?.[model] ?? {}) };
    let changed = false;
    if (context !== undefined) {
      spec.context = context;
      changed = true;
    }
    if (output !== undefined) {
      spec.output = output;
      changed = true;
    }
    if (efforts !== undefined) {
      spec.reasoning = { efforts };
      changed = true;
    }
    if (changed) {
      upsertProvider(settings, id, { modelSpecs: { ...(settings.providers[id]?.modelSpecs ?? {}), [model]: spec } });
    }
  }
  saveSettings(settings);

  const known = listSupportedPackages().includes(runtime);
  const specBits = [
    context !== undefined ? `context ${context}` : null,
    output !== undefined ? `output ${output}` : null,
    efforts ? `efforts ${efforts.join('/')}` : null,
  ].filter(Boolean);
  const notes = [
    `Added ${id}: ${url} via ${runtime}`,
    `models: ${models.join(', ')}`,
    specBits.length ? `specs: ${specBits.join(', ')}` : null,
    payload ? `payload keys: ${Object.keys(payload).join(', ')} (merged into every request body)` : null,
    known ? undefined : 'The runtime package is not bundled; it installs on first use.',
    'Keys (if the endpoint wants one) live outside settings: ranite keys add ' + id,
  ].filter(Boolean);
  return { notice: notes.join('\n'), tone: 'info' };
}

function listProviders(settings: SettingsStore): ProviderCommandOutcome {
  const ids = [...settings.providerOrder, ...Object.keys(settings.providers)].filter(
    (id, index, all) => id in settings.providers && all.indexOf(id) === index,
  );
  if (ids.length === 0) return { notice: 'No providers yet. Add one: /provider add <id> --url <endpoint> --model <id>', tone: 'warn' };
  return { notice: ids.map((id) => providerLine(id, settings)).join('\n'), tone: 'info' };
}

async function checkProvider(settings: SettingsStore, tokens: string[], ping: boolean): Promise<ProviderCommandOutcome> {
  const target = tokens[2];
  if (!target) return fail('Check needs a provider: /provider check <id>[/<model>] [--ping]');
  const [id, explicitModel] = target.split('/');
  const state = settings.providers[id];
  if (!state) return fail(`${id} is not configured. Add it first: /provider add ${id} --url <endpoint> --model <id>`);
  const modelId = explicitModel ?? state.models?.[0];
  if (!modelId) return fail(`${id} has no model. Add one: /provider add ${id} --url ${state.url ?? '<endpoint>'} --model <id>`);

  const notes: string[] = [`${id} / ${modelId}${state.enabled ? '' : ' (disabled)'}`];
  // Custom endpoints build from settings alone; only a catalog provider needs
  // the models.dev index, fetched here (and tolerated offline).
  if (!state.npm && !state.url) {
    try {
      await getCatalogIndex();
    } catch {
      // Offline degrades the catalog check below; the build still reports truth.
    }
  }
  if (isCatalogLoaded() && !getProvider(id) && !state.npm && !state.url) {
    return fail(`${id} has no runtime package and no endpoint, so no model can be built for it.`);
  }
  if (!state.keys.length && Object.keys(state.options ?? {}).length === 0 && !state.npm) {
    notes.push('No credential yet: ranite keys add ' + id);
  }
  const spec = state.modelSpecs?.[modelId];
  const payloadKeys = [...new Set([...Object.keys(state.payload ?? {}), ...Object.keys(spec?.payload ?? {})])];
  const specBits = [
    spec?.context ? `context ${spec.context}` : null,
    spec?.output ? `output ${spec.output}` : null,
    spec?.reasoning?.efforts?.length ? `efforts ${spec.reasoning.efforts.join('/')}` : null,
    payloadKeys.length ? `payload: ${payloadKeys.join(', ')}` : null,
  ].filter(Boolean);
  if (specBits.length > 0) notes.push(`specs: ${specBits.join(', ')}`);

  const built = await createLanguageModel(id, modelId, state, createPayloadFetch(state, modelId));
  if (!built.ok) return fail(`${id} / ${modelId} cannot be built: ${built.error.reason}`);
  notes.push(`build ok${state.npm || state.url ? '' : ' (catalog provider)'}`);
  if (!ping) {
    notes.push('Add --ping to send one tiny request.');
    return { notice: notes.join('\n'), tone: 'info' };
  }
  const model = built.model;
  if (typeof model === 'string') return fail(`${id} / ${modelId} resolved to a model id, not a model instance.`);

  const startedAt = Date.now();
  try {
    const result = await model.doGenerate({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'Reply with OK only.' }] }],
      maxOutputTokens: 64,
    });
    const usage = result.usage;
    // reasoningTokens exists on the current usage shape; the union also carries
    // the older shape, so read it defensively.
    const reasoning = (usage as { reasoningTokens?: number }).reasoningTokens;
    const usageBits = [
      `in ${usage.inputTokens ?? '?'}`,
      `out ${usage.outputTokens ?? '?'}`,
      ...(reasoning ? [`reasoning ${reasoning}`] : []),
    ].join(' / ');
    notes.push(`ping ok in ${Date.now() - startedAt}ms — ${usageBits}`);
    return { notice: notes.join('\n'), tone: 'info' };
  } catch (error) {
    const status =
      typeof (error as { statusCode?: unknown })?.statusCode === 'number' ? ` (${(error as { statusCode: number }).statusCode})` : '';
    notes.push(`ping failed${status} in ${Date.now() - startedAt}ms — ${error instanceof Error ? error.message : String(error)}`);
    return { notice: notes.join('\n'), tone: 'error' };
  }
}

function removeProviderCommand(settings: SettingsStore, tokens: string[]): ProviderCommandOutcome {
  const id = tokens[2];
  if (!id || !PROVIDER_ID.test(id)) return fail('Remove needs a provider id: /provider remove <id>');
  const state = settings.providers[id];
  if (!state) return fail(`${id} is not configured.`);
  const keyCount = state.keys.length;
  removeProvider(settings, id);
  // saveSettings rebuilds the secret store from memory, so the removed provider's
  // keys go with it — that is this command's contract, and the notice says so
  // instead of leaving a silent credential behind (a keys-only entry would also
  // re-enter settings on the next load).
  saveSettings(settings);
  const notes = [`Removed ${id} from settings.`];
  if (keyCount > 0) notes.push(`Also cleared ${keyCount} key(s) from the secret store.`);
  return { notice: notes.join('\n'), tone: 'info' };
}

/** Runs one `/provider ...` line and returns the notice the session should show. */
export async function runProviderCommand(text: string): Promise<ProviderCommandOutcome> {
  try {
    const tokens = tokenize(text.trim());
    const action = tokens[1];
    const settings = loadSettings();
    if (action === 'add') return await addProvider(settings, tokens);
    if (action === 'list') return listProviders(settings);
    if (action === 'check') return await checkProvider(settings, tokens, tokens.includes('--ping'));
    if (action === 'remove') return removeProviderCommand(settings, tokens);
    return { notice: action ? `Unknown /provider action: ${action}\n${USAGE}` : USAGE, tone: action ? 'error' : 'warn' };
  } catch (error) {
    return fail(`The provider command failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
