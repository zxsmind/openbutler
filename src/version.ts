import { readFileSync } from 'node:fs';

let cached: string | undefined;

/** The published package version, read once from the manifest next to the build output. */
export function getRaniteVersion(): string {
  if (cached !== undefined) return cached;
  cached = 'unknown';
  try {
    const manifest: unknown = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    if (manifest && typeof manifest === 'object' && 'version' in manifest && typeof manifest.version === 'string') {
      cached = manifest.version;
    }
  } catch {
    // A missing or malformed manifest is not worth failing a run over.
  }
  return cached;
}
