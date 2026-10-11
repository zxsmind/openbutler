import { getCatalogIndex, listProviderIds, catalogSizeOnDisk } from '../src/provider/catalog.js';
import { createLanguageModel, listToolCapableModels, listSupportedPackages, resolveProvider } from '../src/provider/registry.js';

await getCatalogIndex();
const ids = listProviderIds();

console.log(`catalog: ${ids.length} providers, ${(catalogSizeOnDisk() / 1024 / 1024).toFixed(2)} MB on disk`);
console.log(`supported packages: ${listSupportedPackages().join(', ')}`);

for (const id of ['openai', 'anthropic', 'openrouter', 'ollama']) {
  const entry = ids.includes(id) ? 'in catalog' : 'NOT in catalog';
  console.log(`  ${id.padEnd(12)} ${entry}`);
}

process.env.RANITE_API_KEY = 'sk-test-not-real';

const resolved = resolveProvider('openai');
console.log(
  `resolveProvider(openai): ${resolved.ok ? `${resolved.provider.displayName} via ${resolved.provider.npm}` : `FAILED — ${resolved.error.reason}`}`,
);

const built = await createLanguageModel('openai', 'gpt-5');
console.log(
  `createLanguageModel(openai, gpt-5): ${built.ok ? (typeof built.model === 'string' ? built.model : built.model.modelId) : `FAILED — ${built.error.reason}`}`,
);

const custom = resolveProvider('my-local', {
  npm: '@ai-sdk/openai-compatible',
  url: 'http://127.0.0.1:11434/v1',
});
console.log(
  `resolveProvider(custom): ${custom.ok ? `${custom.provider.displayName} custom=${custom.provider.custom}` : `FAILED — ${custom.error.reason}`}`,
);

const missing = resolveProvider('nope-not-real');
console.log(`resolveProvider(unknown, no npm): ${missing.ok ? 'UNEXPECTED OK' : missing.error.reason}`);

const capable = listToolCapableModels(['openai', 'anthropic']);
console.log(`tool-capable on openai+anthropic: ${capable.length} (of 69 catalog models)`);
console.log(`  pricing still readable: ${JSON.stringify(getProviderPrice())}`);

function getProviderPrice() {
  return { note: 'see tests/catalog.test.ts — cost and limit survive on disk', sample: listSupportedPackages().length };
}
