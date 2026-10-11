/* What the catalog costs, in bytes and in resident memory.
 *
 * Two numbers matter and they are different questions:
 *   - bytes on disk: the catalog is no longer slimmed, so it is the full payload
 *   - bytes held: a run reads the index plus only the provider lines it asks for
 *
 * The two cases run in separate processes. A process that does a cold fetch has
 * already grown V8's heap to fit the 5 MiB payload, and every number after that
 * inherits those pages whether they are needed or not.
 *
 * Run: npx tsx --expose-gc scripts/memory.ts cold
 *      npx tsx --expose-gc scripts/memory.ts warm
 *      npx tsx --expose-gc scripts/memory.ts warm openai anthropic */
const mode = process.argv[2] === 'cold' ? 'cold' : 'warm';
const requested = process.argv.slice(3).filter((arg) => !arg.startsWith('--'));

const mb = (n: number) => n / 1024 / 1024;
const rss = () => mb(process.memoryUsage.rss());

const collect = () => {
  const runGc = (globalThis as { gc?: () => void }).gc;
  runGc?.();
  runGc?.();
};

const catalog = await import('../src/provider/catalog.js');
const hadCache = catalog.isCatalogLoaded();

const beforeAll = rss();
await import('../src/provider/registry.js');
const afterSdk = rss();

if (mode === 'cold') await catalog.getCatalogIndex({ refresh: true });
else await catalog.getCatalogIndex({ fetchImpl: () => Promise.reject(new Error('warm run must not fetch')) });

collect();
const afterIndex = rss();

/* No arguments means every provider, which is the ceiling rather than the
   typical case. A measurement that only looks good when it is handed two
   hand-picked providers is not evidence of anything. */
const allIds = catalog.listProviderIds();
const targets = requested.length > 0 ? requested : allIds;
/* The index carries each line's byte length, so per-line cost is measured rather
   than inferred from the difference of two readings. */
const byId = new Map(catalog.listProviderSummaries().map((entry) => [entry.id, entry]));

let modelsRead = 0;
let biggest = { id: '', models: 0, kb: 0 };
for (const id of targets) {
  const provider = catalog.getProvider(id);
  const count = Object.keys(provider?.models ?? {}).length;
  modelsRead += count;
  const entry = byId.get(id);
  if (entry && entry.length > biggest.kb * 1024) biggest = { id, models: entry.modelCount, kb: entry.length / 1024 };
}

collect();
const held = rss();
const catalogBytes = catalog.catalogSizeOnDisk();

const note = mode === 'warm' ? (hadCache ? ' (cache present)' : ' (NO CACHE)') : ' (fetched)';
console.log(`mode                     ${mode}${note}`);
console.log(
  `scope                    ${targets.length} of ${allIds.length} providers${requested.length > 0 ? ' (named on the command line)' : ' (all)'}`,
);
console.log(`RSS before ranite code   ${beforeAll.toFixed(0)} MB`);
console.log(`RSS after SDK import     ${afterSdk.toFixed(0)} MB   (+${(afterSdk - beforeAll).toFixed(0)})`);
console.log(`RSS after index read     ${afterIndex.toFixed(0)} MB   (+${(afterIndex - afterSdk).toFixed(0)})`);
console.log(`RSS after providers read ${held.toFixed(0)} MB   (+${(held - afterSdk).toFixed(0)})`);
console.log(`catalog on disk          ${mb(catalogBytes).toFixed(2)} MB  (full payload, nothing dropped)`);
console.log(`models materialised      ${modelsRead}`);
console.log(`largest provider line    ${biggest.id}: ${biggest.models} models, ${biggest.kb.toFixed(0)} KB on disk`);
